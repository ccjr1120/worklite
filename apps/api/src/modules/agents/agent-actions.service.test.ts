// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createCanvas } from '@napi-rs/canvas';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { agentExecutions, agentPendingActions, agents, auditLogs, chatSubmissions, externalChats, createDb, initializeDatabase, type Database } from '@worklite/db';
import type { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import { formatWechatReply } from '../connections/wechat/wechat-reply-format';
import { ChatAttachmentsService } from './chat-attachments.service';
import { AgentActionsService } from './agent-actions.service';

function qrPng(offset = 0): Buffer {
  const canvas = createCanvas(128, 128);
  const context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, 128, 128);
  context.fillStyle = 'black';
  for (let row = 0; row < 16; row++) for (let col = 0; col < 16; col++) if ((row + col + offset) % 3 === 0) context.fillRect(col * 8, row * 8, 8, 8);
  return canvas.toBuffer('image/png');
}

describe('Agent authorization delivery and browser entry', () => {
  let db: Database;
  let directory: string;
  let service: AgentActionsService;
  let attachments: ChatAttachmentsService;
  let config: ConfigService;
  let hasSession: ReturnType<typeof vi.fn>;
  let refresh: ReturnType<typeof vi.fn>;
  const png = qrPng();
  const nextPng = qrPng(1);
  const pending = () => ({ id: 'apa_action', type: 'wechat_login' as const, title: 'Scan to sign in', description: 'Scan with administrator WeChat', qrCode: `data:image/png;base64,${png.toString('base64')}`, expiresAt: new Date(Date.now() + 120_000) });

  beforeEach(async () => {
    await mkdir(resolve('.log/test-tmp'), { recursive: true });
    directory = await mkdtemp(resolve('.log/test-tmp/qr-'));
    db = createDb(':memory:'); await initializeDatabase(db);
    db.insert(agents).values({ id: 'agent_chat', workspaceId: 'workspace_personal', name: 'Test Chat', systemPrompt: '', responsibility: 'Test', model: '' }).onConflictDoNothing().run();
    db.insert(agentExecutions).values({ id: 'execution', workspaceId: 'workspace_personal', agentId: 'agent_chat', status: 'running' }).run();
    config = new ConfigService({ SQLITE_PATH: resolve(directory, 'worklite.db') });
    attachments = new ChatAttachmentsService(db, config);
    hasSession = vi.fn(() => true);
    refresh = vi.fn(async () => ({ ...pending(), qrCode: `data:image/png;base64,${nextPng.toString('base64')}` }));
    service = new AgentActionsService(db, { hasSession, refresh, cancel: vi.fn() } as unknown as WechatOfficialAccountService, attachments, config);
  });
  afterEach(async () => { vi.restoreAllMocks(); await service?.onModuleDestroy(); db?.$client.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('queues the QR immediately to the task’s originating WeChat conversation without waiting for its model', async () => {
    db.insert(agentExecutions).values({ id: 'conversation', workspaceId: 'workspace_personal', agentId: 'agent_chat', status: 'running' }).run();
    db.insert(externalChats).values({ id: 'wechat:origin', workspaceId: 'workspace_personal', channel: 'wechat', externalId: 'origin', userId: 'user', executionId: 'conversation' }).run();
    db.insert(externalChats).values({ id: 'wechat:other', workspaceId: 'workspace_personal', channel: 'wechat', externalId: 'other', userId: 'other', executionId: 'other-conversation' }).run();
    db.insert(auditLogs).values({ id: 'dispatch', workspaceId: 'workspace_personal', action: 'chat_agent.dispatched', resource: 'execution', metadata: { conversationId: 'conversation' } }).run();
    const result = await service.save('workspace_personal', 'execution', 'call', pending());
    expect(result.channelDelivery).toBe('queued');
    expect(db.select().from(chatSubmissions).all()).toMatchObject([{ chatId: 'wechat:origin', reference: { authorizationNotice: { actionId: 'apa_action', markdown: result.markdown, scanUrl: result.scanUrl } } }]);
    await service.save('workspace_personal', 'execution', 'call', { ...pending(), expiresAt: new Date(result.expiresAt!) });
    expect(db.select().from(chatSubmissions).all()).toHaveLength(1);
  });

  it('hands the Agent the exact PNG as a native-image attachment plus a working LAN page', async () => {
    const result = await service.save('workspace_personal', 'execution', 'call', pending());
    expect(result.status).toBe('pending');
    expect(result.qrCode).toBe(pending().qrCode);
    expect(await readFile(attachments.open('workspace_personal', result.qrImage!.id).path)).toEqual(png);
    const parts = formatWechatReply(result.markdown);
    expect(parts).toContainEqual(expect.objectContaining({ kind: 'attachment', id: result.qrImage!.id }));
    expect(parts).toContainEqual(expect.objectContaining({ kind: 'text', text: expect.stringContaining(result.scanUrl) }));
    const response = await fetch(result.scanUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain(pending().qrCode);
    expect(html).toContain('http-equiv="refresh"');
    expect(refresh).not.toHaveBeenCalled();
    const again = await service.share('workspace_personal', 'apa_action');
    expect(again.qrImage!.id).toBe(result.qrImage!.id);
    expect(again.scanUrl).toBe(result.scanUrl);
    expect((await fetch(new URL('/api/agents', result.scanUrl))).status).toBe(404);
    expect((await fetch(new URL('/scan/' + '0'.repeat(64), result.scanUrl))).status).toBe(404);
  });

  it('never serves a stale QR and refreshes the same action from the browser with POST/redirect/GET', async () => {
    const result = await service.save('workspace_personal', 'execution', 'call', pending());
    db.update(agentPendingActions).set({ status: 'expired', expiresAt: new Date(Date.now() - 1) }).where(eq(agentPendingActions.id, 'apa_action')).run();
    const expired = await service.share('workspace_personal', 'apa_action');
    expect(expired.qrImage).toBeNull(); expect(expired.qrCode).toBeNull();
    const oldPage = await fetch(result.scanUrl).then((response) => response.text());
    expect(oldPage).toContain('二维码已过期'); expect(oldPage).not.toContain('<img');
    const denied = await fetch(result.scanUrl, { method: 'POST', headers: { Origin: 'https://other.example' } });
    expect(denied.status).toBe(404); expect(refresh).not.toHaveBeenCalled();
    const response = await fetch(result.scanUrl, { method: 'POST', redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('apa_action');
    const page = await fetch(result.scanUrl).then((response) => response.text());
    expect(page).toContain(nextPng.toString('base64'));
    expect(db.select().from(agentPendingActions).get()).toMatchObject({ id: 'apa_action', status: 'pending', nodeRunId: 'call' });
  });

  it('reports a session lost after restart as expired even before the recorded QR deadline', async () => {
    await service.save('workspace_personal', 'execution', 'call', pending());
    hasSession.mockReturnValue(false);
    const result = await service.share('workspace_personal', 'apa_action');
    expect(result).toMatchObject({ status: 'expired', qrCode: null, qrImage: null });
    expect(await service.page(result.scanUrl.split('/').at(-1)!)).not.toContain('<img');
  });

  it.each(['completed', 'cancelled'] as const)('does not resurrect a %s action', async (status) => {
    const result = await service.save('workspace_personal', 'execution', 'call', pending());
    db.update(agentPendingActions).set({ status }).where(eq(agentPendingActions.id, 'apa_action')).run();
    await expect(service.refresh('workspace_personal', 'apa_action')).rejects.toThrow('no longer waiting');
    expect(refresh).not.toHaveBeenCalled();
    const page = await fetch(result.scanUrl).then((response) => response.text());
    expect(page).not.toContain('<img'); expect(page).not.toContain('<form');
  });

  it('deduplicates concurrent refreshes, updates saved fields and scopes inspection to the workspace', async () => {
    await service.save('workspace_personal', 'execution', 'call', pending());
    await Promise.all([service.refresh('workspace_personal', 'apa_action'), service.refresh('workspace_personal', 'apa_action')]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(db.select().from(agentPendingActions).get()?.qrCode).toContain(nextPng.toString('base64'));
    await expect(service.share('other-workspace', 'apa_action')).rejects.toThrow('not found');
    await expect(service.refresh('other-workspace', 'apa_action')).rejects.toThrow('not found');
  });

  it('uses a configured public URL and expires bearer links independently of the QR', async () => {
    config.set('WORKLITE_PUBLIC_URL', 'https://worklite.example/');
    const result = await service.save('workspace_personal', 'execution', 'call', pending());
    expect(result.scanUrl).toMatch(/^https:\/\/worklite\.example\/api\/agent-actions\/scan\/[a-f0-9]{64}$/);
    expect(service.allowPageOrigin('https://worklite.example', '127.0.0.1:23391')).toBe(true);
    expect(service.allowPageOrigin('https://other.example', '127.0.0.1:23391')).toBe(false);
    expect(service.allowPageOrigin('invalid-url', '127.0.0.1:23391')).toBe(false);
    const token = result.scanUrl.split('/').at(-1)!;
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    await expect(service.page(token)).rejects.toThrow('链接已过期');
  });

  it('re-saves all QR fields when a resumed operation waits again', async () => {
    const first = await service.save('workspace_personal', 'execution', 'call', pending());
    const updated = await service.save('workspace_personal', 'execution', 'call', { ...pending(), qrCode: `data:image/png;base64,${nextPng.toString('base64')}`, expiresAt: new Date(Date.now() + 180_000), title: 'New QR' });
    expect(updated.qrImage!.id).not.toBe(first.qrImage!.id);
    expect(db.select().from(agentPendingActions).get()).toMatchObject({ title: 'New QR', qrCode: updated.qrCode });
  });
});
