import { BadRequestException, Inject, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { agentPendingActions, auditLogs, chatSubmissions, externalChats, type Database } from '@worklite/db';
import type { ChatAttachmentView } from '@worklite/contracts';
import type { PendingNodeExecutionResult } from '@worklite/workflow-engine';
import { DATABASE } from '../../infrastructure/database.module';
import { inspectQrPng } from '../connections/qr-png';
import { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import { ChatAttachmentsService } from './chat-attachments.service';

type Action = typeof agentPendingActions.$inferSelect;
const LINK_LIFETIME_MS = 15 * 60_000;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Share the QR from the controlled session, rather than a separate mp.weixin login. */
@Injectable()
export class AgentActionsService implements OnModuleDestroy {
  private readonly links = new Map<string, { actionId: string; workspaceId: string; expires: number }>();
  private readonly images = new Map<string, { qrCode: string; image: ChatAttachmentView }>();
  private readonly refreshes = new Map<string, Promise<ReturnType<AgentActionsService['require']>>>();
  private server?: Server;
  private listening?: Promise<string>;

  constructor(@Inject(DATABASE) private readonly db: Database, private readonly wechat: WechatOfficialAccountService, private readonly attachments: ChatAttachmentsService, private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  require(workspaceId: string, actionId: string): Action {
    const action = this.db.select().from(agentPendingActions).where(and(eq(agentPendingActions.id, actionId), eq(agentPendingActions.workspaceId, workspaceId))).get();
    if (!action) throw new NotFoundException('Agent action not found.');
    return action;
  }

  async save(workspaceId: string, runId: string, nodeRunId: string, pending: PendingNodeExecutionResult['pendingAction']) {
    const fields = { type: pending.type, title: pending.title, description: pending.description, qrCode: pending.qrCode, expiresAt: pending.expiresAt, externalOperationId: pending.externalOperationId ?? null };
    this.db.insert(agentPendingActions).values({ id: pending.id, workspaceId, runId, nodeRunId, ...fields }).onConflictDoUpdate({ target: agentPendingActions.id, set: { ...fields, status: 'pending', updatedAt: new Date() } }).run();
    const delivery = await this.share(workspaceId, pending.id);
    return { ...delivery, channelDelivery: this.queueWechat(workspaceId, runId, delivery) ? 'queued' : null };
  }

  async share(workspaceId: string, actionId: string) {
    const action = this.require(workspaceId, actionId);
    const live = action.status === 'pending' && !!action.expiresAt && action.expiresAt.getTime() > Date.now() && this.wechat.hasSession(actionId);
    const qr = live ? inspectQrPng(action.qrCode) : null;
    let qrImage: ChatAttachmentView | null = null;
    if (qr) {
      const cached = this.images.get(actionId);
      qrImage = cached?.qrCode === qr.dataUrl && new Date(cached.image.expiresAt).getTime() > Date.now() ? cached.image : await this.attachments.create(workspaceId, {
        mimeType: 'image/png', fileName: '公众号授权二维码.png', body: Buffer.from(qr.dataUrl.split(',')[1]!, 'base64'),
      });
      this.images.set(actionId, { qrCode: qr.dataUrl, image: qrImage });
    }
    const status = action.status === 'pending' && !live ? 'expired' as const : action.status;
    const scanUrl = await this.scanUrl(action);
    return { id: action.id, type: action.type, title: action.title, description: action.description, status, expiresAt: action.expiresAt?.toISOString() ?? null,
      qrCode: qr?.dataUrl ?? null, qrImage, scanUrl,
      markdown: [qrImage?.markdown, `公众号授权页面：${scanUrl}`].filter(Boolean).join('\n\n') };
  }

  async refresh(workspaceId: string, actionId: string) {
    this.require(workspaceId, actionId);
    let work = this.refreshes.get(actionId);
    if (!work) {
      work = (async () => {
        const action = this.require(workspaceId, actionId);
        if (action.status !== 'pending' && action.status !== 'expired') throw new BadRequestException('This authorization is no longer waiting for input.');
        const pending = await this.wechat.refresh(actionId);
        const updated = this.db.update(agentPendingActions).set({ type: pending.type, title: pending.title, description: pending.description, qrCode: pending.qrCode, expiresAt: pending.expiresAt, externalOperationId: pending.externalOperationId ?? null, status: 'pending', updatedAt: new Date() })
          .where(and(eq(agentPendingActions.id, actionId), eq(agentPendingActions.status, action.status))).returning().get();
        if (!updated) { await this.wechat.cancel(actionId); throw new BadRequestException('Authorization changed while refreshing.'); }
        return updated;
      })();
      this.refreshes.set(actionId, work);
    }
    try { await work; } finally { if (this.refreshes.get(actionId) === work) this.refreshes.delete(actionId); }
    const delivery = await this.share(workspaceId, actionId);
    const action = this.require(workspaceId, actionId);
    return { ...delivery, channelDelivery: this.queueWechat(workspaceId, action.runId, delivery) ? 'queued' : null };
  }

  private queueWechat(workspaceId: string, runId: string, delivery: Awaited<ReturnType<AgentActionsService['share']>>): boolean {
    // Freeze the origin of this background task, never the most recent chat.
    const binding = this.db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'chat_agent.dispatched'), eq(auditLogs.resource, runId))).get();
    const conversationId = typeof binding?.metadata.conversationId === 'string' ? binding.metadata.conversationId : runId;
    const chat = this.db.select().from(externalChats).where(and(eq(externalChats.workspaceId, workspaceId), eq(externalChats.executionId, conversationId), eq(externalChats.channel, 'wechat'))).get();
    if (!chat) return false;
    const revision = createHash('sha256').update(`${delivery.qrCode}:${delivery.expiresAt}:${delivery.scanUrl}`).digest('hex').slice(0, 24);
    this.db.insert(chatSubmissions).values({ id: `authorization_${delivery.id}_${revision}`, workspaceId, chatId: chat.id, executionId: conversationId, message: '', target: { kind: 'conversation' }, reference: {
      kind: 'conversation', executionId: conversationId, afterMessageId: null, afterSequence: 0, completionStatus: 'completed',
      authorizationNotice: { actionId: delivery.id, markdown: delivery.markdown, scanUrl: delivery.scanUrl, expiresAt: delivery.expiresAt },
    } }).onConflictDoNothing().run();
    return true;
  }

  async page(token: string, refresh = false): Promise<string> {
    const link = this.links.get(token);
    if (!link || link.expires <= Date.now()) { this.links.delete(token); if (link) this.images.delete(link.actionId); throw new NotFoundException('授权链接已过期，请在对话中重新获取。'); }
    if (refresh) await this.refresh(link.workspaceId, link.actionId);
    const action = this.require(link.workspaceId, link.actionId);
    const live = action.status === 'pending' && !!action.expiresAt && action.expiresAt.getTime() > Date.now() && this.wechat.hasSession(action.id);
    const qr = live ? inspectQrPng(action.qrCode) : null;
    const waiting = action.status === 'pending' || action.status === 'expired';
    const content = qr ? `<p>请使用公众号管理员微信扫码授权。</p><img alt="公众号授权二维码" src="${qr.dataUrl}" width="320"><p>有效期至 ${escapeHtml(action.expiresAt!.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</p>`
      : `<p>${action.status === 'completed' ? '授权已完成，请返回对话继续。' : action.status === 'cancelled' ? '授权已取消，请返回对话。' : '二维码已过期，请刷新后扫码。'}</p>`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${live ? '<meta http-equiv="refresh" content="3">' : ''}<title>公众号扫码授权</title><style>body{max-width:440px;margin:40px auto;padding:0 20px;text-align:center;font:16px/1.6 system-ui}img{max-width:100%;height:auto}button{padding:10px 20px;font:inherit}</style></head><body><h1>公众号扫码授权</h1>${content}${waiting ? '<form method="post"><button type="submit">刷新二维码</button></form>' : ''}</body></html>`;
  }

  allowPageOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (!origin) return true;
    try {
      const configured = this.config.get<string>('WORKLITE_PUBLIC_URL')?.trim();
      return configured ? new URL(origin).origin === new URL(configured).origin : new URL(origin).host === host;
    } catch { return false; }
  }

  private async scanUrl(action: Action): Promise<string> {
    for (const [token, link] of this.links) if (link.expires <= Date.now()) { this.links.delete(token); this.images.delete(link.actionId); }
    let token = [...this.links].find(([, link]) => link.actionId === action.id && link.workspaceId === action.workspaceId)?.[0];
    if (!token) { token = randomBytes(32).toString('hex'); this.links.set(token, { actionId: action.id, workspaceId: action.workspaceId, expires: Date.now() + LINK_LIFETIME_MS }); }
    const configured = this.config.get<string>('WORKLITE_PUBLIC_URL')?.trim();
    if (configured) {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BadRequestException('WORKLITE_PUBLIC_URL must be an HTTP(S) base URL.');
      return `${configured.replace(/\/$/, '')}/api/agent-actions/scan/${token}`;
    }
    return `${await this.localOrigin()}/scan/${token}`;
  }

  /** Only token-scoped QR pages are exposed on LAN; the management API stays loopback-only. */
  private localOrigin(): Promise<string> {
    if (this.listening) return this.listening;
    this.listening = new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
        const token = /^\/scan\/([a-f0-9]{64})$/.exec(request.url ?? '')?.[1];
        if (!token || !['GET', 'POST'].includes(request.method ?? '') || (request.method === 'POST' && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
          response.writeHead(404).end(); return;
        }
        void this.page(token, request.method === 'POST').then((html) => {
          // Redirect after refresh so the page's timed GET never repeats a POST.
          if (request.method === 'POST') response.writeHead(303, { Location: request.url! }).end();
          else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
        }).catch((error: unknown) => {
          response.writeHead(error instanceof NotFoundException ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error instanceof Error ? error.message : '授权页面暂时不可用，请返回对话重试。');
        });
      });
      this.server = server;
      server.once('error', (error) => { this.listening = undefined; reject(error); });
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        const interfaces = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(!a.startsWith('en')) - Number(!b.startsWith('en')));
        const host = interfaces.flatMap(([, values]) => values ?? []).find((entry) => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address ?? '127.0.0.1';
        server.unref();
        resolve(`http://${host}:${typeof address === 'object' && address ? address.port : 0}`);
      });
    });
    return this.listening;
  }
}
