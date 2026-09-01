import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { pluginWechatConversations, plugins, type Database } from '@worklite/db';
import type { WechatConnectionView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { AgentExecutionsService } from '../agents/agent-executions.service';
import { CODEX_CLI_AGENT_ID, CODEX_CLI_PLUGIN_ID, encryptSecret, PluginsService } from './plugins.service';

const CHANNEL_VERSION = '2.1.1';
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const pollers = new Map<string, Promise<void>>();
type JsonRecord = Record<string, unknown>;

@Injectable()
export class WechatClawbotService implements OnModuleInit, OnModuleDestroy {
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly plugins: PluginsService,
    private readonly executions: AgentExecutionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.db.select({ id: plugins.id, token: plugins.wechatToken, status: plugins.wechatStatus }).from(plugins).where(eq(plugins.id, CODEX_CLI_PLUGIN_ID));
    if (rows[0]?.token) this.startPolling(rows[0].id);
    else if (rows[0]?.status === 'qr_pending' || rows[0]?.status === 'error') await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatStatus: 'disconnected', wechatQrCode: null, wechatQrKey: null, wechatLastError: null });
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  async startLogin(): Promise<WechatConnectionView> {
    const { baseUrl } = await this.plugins.wechatSecret(CODEX_CLI_PLUGIN_ID);
    const qr = await this.issueLoginQr(baseUrl || DEFAULT_BASE_URL);
    void this.waitForLogin(qr.qrKey, qr.baseUrl, 0);
    return (await this.plugins.get(CODEX_CLI_PLUGIN_ID)).wechat;
  }

  async disconnect(): Promise<WechatConnectionView> {
    await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatToken: null, wechatBotId: null, wechatStatus: 'disconnected', wechatQrCode: null, wechatQrKey: null, wechatCursor: '', wechatLastError: null });
    return (await this.plugins.get(CODEX_CLI_PLUGIN_ID)).wechat;
  }

  private async issueLoginQr(baseUrl: string): Promise<{ qrKey: string; baseUrl: string }> {
    const response = await this.getJson(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`);
    if (typeof response.qrcode !== 'string' || typeof response.qrcode_img_content !== 'string') throw new Error('WeChat did not return a login QR code.');
    const resolvedBaseUrl = typeof response.baseurl === 'string' && response.baseurl ? response.baseurl : baseUrl;
    await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatBaseUrl: resolvedBaseUrl, wechatStatus: 'qr_pending', wechatQrCode: response.qrcode_img_content, wechatQrKey: response.qrcode, wechatLastError: null });
    return { qrKey: response.qrcode, baseUrl: resolvedBaseUrl };
  }

  private async waitForLogin(qrKey: string, baseUrl: string, refreshCount: number): Promise<void> {
    try {
      for (let attempt = 0; attempt < 240 && !this.stopped; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const result = await this.getJson(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrKey)}`);
        if (result.status === 'confirmed' || result.bot_token) {
          const resolvedBaseUrl = typeof result.baseurl === 'string' && result.baseurl ? result.baseurl : baseUrl;
          const botId = typeof result.ilink_bot_id === 'string' ? result.ilink_bot_id : typeof result.bot_id === 'string' ? result.bot_id : null;
          await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatBaseUrl: resolvedBaseUrl, wechatToken: result.bot_token ? encryptSecret(String(result.bot_token).replace(/^Bearer\s+/i, '')) : null, wechatBotId: botId, wechatStatus: 'connected', wechatQrCode: null, wechatQrKey: null, wechatCursor: '', wechatLastError: null });
          this.startPolling(CODEX_CLI_PLUGIN_ID);
          return;
        }
        if (result.status === 'scaned_but_redirect' && typeof result.redirect_host === 'string' && result.redirect_host) {
          baseUrl = `https://${result.redirect_host}`;
          await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatBaseUrl: baseUrl });
        }
        if (result.status === 'expired') {
          if (refreshCount >= 3) throw new Error('The WeChat login QR code expired after three refreshes.');
          const next = await this.issueLoginQr(baseUrl);
          return this.waitForLogin(next.qrKey, next.baseUrl, refreshCount + 1);
        }
      }
      if (!this.stopped) throw new Error('The WeChat login QR code expired.');
    } catch (error) {
      await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatStatus: 'error', wechatLastError: error instanceof Error ? error.message : 'WeChat login failed.' });
    }
  }

  private startPolling(pluginId: string): void {
    if (pollers.has(pluginId)) return;
    const task = this.poll(pluginId).finally(() => pollers.delete(pluginId));
    pollers.set(pluginId, task);
  }

  private async poll(pluginId: string): Promise<void> {
    while (!this.stopped) {
      const secret = await this.plugins.wechatSecret(pluginId);
      if (!secret.token) return;
      try {
        const [row] = await this.db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
        if (!row || row.wechatStatus !== 'connected') return;
        const result = await this.postJson(`${secret.baseUrl}/ilink/bot/getupdates`, { get_updates_buf: row.wechatCursor, base_info: { channel_version: CHANNEL_VERSION } }, secret.token, 45_000);
        const messages = Array.isArray(result.msgs) ? result.msgs.filter(isRecord) : [];
        for (const message of messages) await this.handleMessage(pluginId, message);
        if (typeof result.get_updates_buf === 'string' && result.get_updates_buf) await this.plugins.updateWechat(pluginId, { wechatCursor: result.get_updates_buf });
      } catch (error) {
        await this.plugins.updateWechat(pluginId, { wechatStatus: 'error', wechatLastError: error instanceof Error ? error.message : 'WeChat polling failed.' });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  private async handleMessage(pluginId: string, message: JsonRecord): Promise<void> {
    const nestedMessage = asRecord(message.msg);
    const userId = String(message.from_user_id || message.user_id || nestedMessage?.from_user_id || '');
    const text = extractText(message);
    if (!userId || !text || message.message_type === 2) return;
    const contextToken = String(message.context_token || nestedMessage?.context_token || '');
    const [existing] = await this.db.select().from(pluginWechatConversations).where(and(eq(pluginWechatConversations.pluginId, pluginId), eq(pluginWechatConversations.userId, userId))).limit(1);
    const executionId = await this.executions.createOrContinueBackgroundExecution(existing?.workspaceId || 'workspace_personal', CODEX_CLI_AGENT_ID, existing?.executionId || null, text);
    if (existing) await this.db.update(pluginWechatConversations).set({ executionId, contextToken: contextToken || existing.contextToken, updatedAt: new Date() }).where(eq(pluginWechatConversations.id, existing.id));
    else await this.db.insert(pluginWechatConversations).values({ id: `wxc_${randomUUID()}`, pluginId, workspaceId: 'workspace_personal', userId, executionId, contextToken: contextToken || null });
    const response = await this.executions.waitForCompletion('workspace_personal', executionId);
    const secret = await this.plugins.wechatSecret(pluginId);
    if (!secret.token) return;
    await this.postJson(`${secret.baseUrl}/ilink/bot/sendmessage`, { msg: { from_user_id: '', to_user_id: userId, client_id: `worklite-${randomBytes(8).toString('hex')}`, message_type: 2, message_state: 2, context_token: contextToken || existing?.contextToken || '', item_list: [{ type: 1, text_item: { text: response } }] }, base_info: { channel_version: CHANNEL_VERSION } }, secret.token);
  }

  private async getJson(url: string): Promise<JsonRecord> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`WeChat request failed with HTTP ${response.status}.`);
    return response.json() as Promise<JsonRecord>;
  }

  private async postJson(url: string, payload: JsonRecord, token: string, timeoutMs = 15_000): Promise<JsonRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = JSON.stringify(payload);
      const response = await fetch(url, { method: 'POST', headers: { ...this.headers(), Authorization: `Bearer ${token}`, 'Content-Length': String(Buffer.byteLength(body)) }, body, signal: controller.signal });
      if (!response.ok) throw new Error(`WeChat request failed with HTTP ${response.status}.`);
      return response.json() as Promise<JsonRecord>;
    } finally { clearTimeout(timer); }
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString('base64') };
  }
}

function extractText(message: JsonRecord): string {
  const nestedMessage = asRecord(message.msg);
  const items = message.item_list || nestedMessage?.item_list;
  if (!Array.isArray(items)) return '';
  return items.filter(isRecord).flatMap((item) => {
    const textItem = asRecord(item.text_item);
    return item.type === 1 && typeof textItem?.text === 'string' ? [textItem.text] : [];
  }).join('\n').trim();
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return asRecord(value) !== undefined;
}
