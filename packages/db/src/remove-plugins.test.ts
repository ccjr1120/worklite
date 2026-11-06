import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, type Database } from './client';
import * as schema from './schema';

let db: Database | undefined;
afterEach(() => { db?.$client.close(); db = undefined; });
const migrationRoot = resolve(process.cwd(), 'packages/db/drizzle');

describe('retiring executable plugins', () => {
  it('initializes without plugins or Codex CLI Chat and preserves channel settings on restart', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    expect(db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugins'").get()).toBeUndefined();
    expect(db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_codex_cli_chat')).get()).toBeUndefined();
    db.update(schema.chatChannels).set({ wechatBotToken: 'encrypted-token', wechatAllowedUserId: 'user', wechatSyncBuf: 'cursor', wechatEnabled: true }).where(eq(schema.chatChannels.id, 'wechat')).run();
    await initializeDatabase(db);
    expect(db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, 'wechat')).get()).toMatchObject({ wechatBotToken: 'encrypted-token', wechatAllowedUserId: 'user', wechatSyncBuf: 'cursor', wechatEnabled: true });
    const chat = db.select().from(schema.agents).where(eq(schema.agents.id, 'agt_system_helper_chat')).get()!;
    expect(chat.systemPrompt).toContain('Codex App Server and Claude Agent SDK are built-in Agent runtimes');
    expect(chat.systemPrompt).not.toContain('/plugins');
  });

  it('migrates encrypted credentials and registrations while keeping account sessions and execution history', () => {
    db = createDb(':memory:');
    const journal = JSON.parse(readFileSync(resolve(migrationRoot, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      if (entry.tag === '0081_remove_plugins') break;
      db.$client.exec(readFileSync(resolve(migrationRoot, `${entry.tag}.sql`), 'utf8'));
    }
    db.insert(schema.workspaces).values({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }).run();
    db.$client.exec(`
      INSERT INTO plugins (id, workspace_id, name, description, command, wechat_bot_id, wechat_bot_token, wechat_base_url, wechat_allowed_user_id, wechat_enabled, wechat_status, wechat_sync_buf)
        VALUES ('wechat-bot', 'workspace_personal', 'WeChat', '', '', 'bot', 'encrypted-token', 'https://example.com', 'user', 1, 'connected', 'cursor');
      INSERT INTO plugins (id, workspace_id, name, description, command, feishu_app_id, feishu_app_secret)
        VALUES ('feishu-bot', 'workspace_personal', 'Feishu', '', '', 'app', 'encrypted-secret');
      INSERT INTO plugins (id, workspace_id, name, description, command) VALUES ('codex-cli-chat', 'workspace_personal', 'Codex', '', 'custom-launch');
      INSERT INTO feishu_registrations (plugin_id, id, status, device_code) VALUES ('feishu-bot', 'registration', 'pending', 'encrypted-device-code');
    `);
    db.insert(schema.wechatOfficialAccounts).values({ id: 'wechat_official_account_personal', workspaceId: 'workspace_personal', displayName: 'Publisher', status: 'connected', encryptedStorageState: 'encrypted-session' }).run();
    db.insert(schema.agents).values({ id: 'agt_codex_cli_chat', workspaceId: 'workspace_personal', kind: 'system', name: 'Codex CLI Chat', responsibility: '', systemPrompt: '', model: '' }).run();
    db.insert(schema.agentExecutions).values({ id: 'legacy-execution', workspaceId: 'workspace_personal', agentId: 'agt_codex_cli_chat', status: 'running', displayMessages: [{ id: 'message', role: 'user', content: 'Keep this history', createdAt: new Date().toISOString() }] }).run();
    db.$client.exec(readFileSync(resolve(migrationRoot, '0081_remove_plugins.sql'), 'utf8'));

    expect(db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, 'wechat')).get()).toMatchObject({ wechatBotId: 'bot', wechatBotToken: 'encrypted-token', wechatBaseUrl: 'https://example.com', wechatAllowedUserId: 'user', wechatEnabled: true, wechatStatus: 'connected', wechatSyncBuf: 'cursor' });
    expect(db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, 'feishu')).get()).toMatchObject({ feishuAppId: 'app', feishuAppSecret: 'encrypted-secret' });
    expect(db.select().from(schema.feishuRegistrations).get()).toMatchObject({ channelId: 'feishu', id: 'registration', deviceCode: 'encrypted-device-code' });
    expect(db.select().from(schema.wechatOfficialAccounts).get()).toMatchObject({ status: 'connected', encryptedStorageState: 'encrypted-session' });
    expect(db.select().from(schema.agentExecutions).get()).toMatchObject({ status: 'failed', displayMessages: [expect.objectContaining({ content: 'Keep this history' })] });
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
});
