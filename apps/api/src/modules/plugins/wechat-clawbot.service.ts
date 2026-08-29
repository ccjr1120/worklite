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

@Injectable()
export class WechatClawbotService implements OnModuleInit, OnModuleDestroy {
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly plugins: PluginsService,
    private readonly executions: AgentExecutionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.db.select({ id: plugins.id, token: plugins.wechatToken }).from(plugins).where(eq(plugins.id, CODEX_CLI_PLUGIN_ID));
    if (rows[0]?.token) this.startPolling(rows[0].id);
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  async startLogin(): Promise<WechatConnectionView> {
    const { baseUrl } = await this.plugins.wechatSecret(CODEX_CLI_PLUGIN_ID);
    const response = await this.getJson(`${baseUrl || DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
    if (typeof response.qrcode !== 'string' || typeof response.qrcode_img_content !== 'string') throw new Error('WeChat did not return a login QR code.');
    await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatBaseUrl: response.baseurl || baseUrl || DEFAULT_BASE_URL, wechatStatus: 'qr_pending', wechatQrCode: response.qrcode_img_content || null, wechatQrKey: response.qrcode || null, wechatLastError: null });
    void this.waitForLogin(response.qrcode, response.baseurl || baseUrl || DEFAULT_BASE_URL);
    return (await this.plugins.get(CODEX_CLI_PLUGIN_ID)).wechat;
  }

  async disconnect(): Promise<WechatConnectionView> {
    await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatToken: null, wechatBotId: null, wechatStatus: 'disconnected', wechatQrCode: null, wechatQrKey: null, wechatCursor: '', wechatLastError: null });
    return (await this.plugins.get(CODEX_CLI_PLUGIN_ID)).wechat;
  }

  private async waitForLogin(qrKey: string, baseUrl: string): Promise<void> {
    try {
      for (let attempt = 0; attempt < 90 && !this.stopped; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const result = await this.getJson(`${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrKey)}`);
        if (result.status === 'confirmed' || result.bot_token) {
          await this.plugins.updateWechat(CODEX_CLI_PLUGIN_ID, { wechatBaseUrl: result.baseurl || baseUrl, wechatToken: result.bot_token ? encryptSecret(result.bot_token) : null, wechatBotId: result.bot_id || null, wechatStatus: 'connected', wechatQrCode: null, wechatQrKey: null, wechatCursor: '', wechatLastError: null });
          this.startPolling(CODEX_CLI_PLUGIN_ID);
          return;
        }
        if (result.status === 'expired') throw new Error('The WeChat login QR code expired.');
      }
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
        for (const message of Array.isArray(result.msgs) ? result.msgs : []) await this.handleMessage(pluginId, message);
        if (result.get_updates_buf) await this.plugins.updateWechat(pluginId, { wechatCursor: result.get_updates_buf });
      } catch (error) {
        await this.plugins.updateWechat(pluginId, { wechatStatus: 'error', wechatLastError: error instanceof Error ? error.message : 'WeChat polling failed.' });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }

  private async handleMessage(pluginId: string, message: Record<string, any>): Promise<void> {
    const userId = String(message.from_user_id || message.user_id || message.msg?.from_user_id || '');
    const text = extractText(message);
    if (!userId || !text || message.message_type === 2) return;
    const contextToken = String(message.context_token || message.msg?.context_token || '');
    const [existing] = await this.db.select().from(pluginWechatConversations).where(and(eq(pluginWechatConversations.pluginId, pluginId), eq(pluginWechatConversations.userId, userId))).limit(1);
    const executionId = await this.executions.createOrContinueBackgroundExecution(existing?.workspaceId || 'workspace_personal', CODEX_CLI_AGENT_ID, existing?.executionId || null, text);
    if (existing) await this.db.update(pluginWechatConversations).set({ executionId, contextToken: contextToken || existing.contextToken, updatedAt: new Date() }).where(eq(pluginWechatConversations.id, existing.id));
    else await this.db.insert(pluginWechatConversations).values({ id: `wxc_${randomUUID()}`, pluginId, workspaceId: 'workspace_personal', userId, executionId, contextToken: contextToken || null });
    const response = await this.executions.waitForCompletion('workspace_personal', executionId);
    const secret = await this.plugins.wechatSecret(pluginId);
    if (!secret.token) return;
    await this.postJson(`${secret.baseUrl}/ilink/bot/sendmessage`, { msg: { from_user_id: '', to_user_id: userId, client_id: `worklite-${randomBytes(8).toString('hex')}`, message_type: 2, message_state: 2, context_token: contextToken || existing?.contextToken || '', item_list: [{ type: 1, text_item: { text: response } }] }, base_info: { channel_version: CHANNEL_VERSION } }, secret.token);
  }

  private async getJson(url: string): Promise<Record<string, any>> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`WeChat request failed with HTTP ${response.status}.`);
    return response.json() as Promise<Record<string, any>>;
  }

  private async postJson(url: string, payload: Record<string, any>, token: string, timeoutMs = 15_000): Promise<Record<string, any>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = JSON.stringify(payload);
      const response = await fetch(url, { method: 'POST', headers: { ...this.headers(), Authorization: `Bearer ${token}`, 'Content-Length': String(Buffer.byteLength(body)) }, body, signal: controller.signal });
      if (!response.ok) throw new Error(`WeChat request failed with HTTP ${response.status}.`);
      return response.json() as Promise<Record<string, any>>;
    } finally { clearTimeout(timer); }
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString('base64') };
  }
}

function extractText(message: Record<string, any>): string {
  const items = message.item_list || message.msg?.item_list;
  if (!Array.isArray(items)) return '';
  return items.filter((item) => item?.type === 1 && typeof item?.text_item?.text === 'string').map((item) => item.text_item.text).join('\n').trim();
}
