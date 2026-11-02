import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { CHAT_AGENT_ID, type ChatConversationSummary } from '@worklite/contracts';
import { agentExecutions, chatSubmissions, createDb, externalChats, feishuEvents, initializeDatabase, wechatEvents, type Database } from '@worklite/db';
import type { WorkspaceService } from '../teams/teams.service';
import type { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { AgentExecutionsService } from './agent-executions.service';
import { ChatConversationsService } from './chat-conversations.service';

const WORKSPACE_ID = 'workspace_personal';
const request = {} as Request;
let db: Database;
let service: ChatConversationsService;

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  service = new ChatConversationsService(db, workspaces, {} as AgentExecutionsService, {} as WorkspaceResourcesService);
});

afterEach(() => db.$client.close());

/**
 * The list algorithm before paging moved into SQL: read every source whole, then filter,
 * sort and cut one page in memory. The new implementation must return identical pages.
 */
function previousList(query: { cursor?: string; search?: string; channel?: string }): { items: ChatConversationSummary[]; nextCursor: string | null } {
  const client = db.$client;
  const search = query.search?.trim();
  const rows = client.prepare(`SELECT id, status, coalesce(json_extract(display_messages, '$[0].content'), '') AS title, created_at, updated_at,
      (SELECT chat_id FROM chat_submissions WHERE execution_id = agent_executions.id AND chat_id IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS chat_id
    FROM agent_executions WHERE workspace_id = ? AND agent_id = ?${search ? ' AND display_messages LIKE ?' : ''}`)
    .all(...[WORKSPACE_ID, CHAT_AGENT_ID, ...(search ? [`%${search}%`] : [])]) as Array<{ id: string; status: string; title: string; created_at: number; updated_at: number; chat_id: string | null }>;
  const channels = new Map((client.prepare('SELECT id, channel FROM external_chats').all() as Array<{ id: string; channel: string }>).map((row) => [row.id, row.channel]));
  const items: ChatConversationSummary[] = rows.map((row) => ({ id: row.id, executionId: row.id, title: row.title, channel: row.chat_id ? channels.get(row.chat_id) ?? 'feishu' : 'web', channelConversationId: row.chat_id, status: row.status as ChatConversationSummary['status'], createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }));
  const tasks = client.prepare('SELECT id, message, error, created_at, updated_at FROM chat_submissions WHERE workspace_id = ? AND execution_id IS NULL AND chat_id IS NULL AND reference IS NOT NULL').all(WORKSPACE_ID) as Array<{ id: string; message: string; error: string | null; created_at: number; updated_at: number }>;
  for (const task of tasks) {
    if (search && !task.message.toLowerCase().includes(search.toLowerCase())) continue;
    items.push({ id: task.id, executionId: null, title: task.message, channel: 'web', channelConversationId: null, status: task.error ? 'failed' : 'task', createdAt: new Date(task.created_at).toISOString(), updatedAt: new Date(task.updated_at).toISOString() });
  }
  const waiting = client.prepare('SELECT id, channel, updated_at FROM external_chats WHERE workspace_id = ? AND execution_id IS NULL').all(WORKSPACE_ID) as Array<{ id: string; channel: 'feishu' | 'wechat'; updated_at: number }>;
  for (const chat of waiting) {
    const table = chat.channel === 'wechat' ? 'wechat_events' : 'feishu_events';
    const receipt = client.prepare(`SELECT payload, status, created_at FROM ${table} WHERE chat_id = ? AND json_extract(payload, '$.direction') IS NULL ORDER BY created_at DESC LIMIT 1`).get(chat.id) as { payload: string; status: string; created_at: number } | undefined;
    const payload = receipt ? JSON.parse(receipt.payload) as { text?: unknown } : undefined;
    const title = typeof payload?.text === 'string' ? payload.text : '';
    if (search && !title.toLowerCase().includes(search.toLowerCase())) continue;
    items.push({ id: chat.id, executionId: null, title, channel: chat.channel, channelConversationId: chat.id, status: receipt?.status === 'failed' ? 'failed' : 'queued', createdAt: new Date(receipt?.created_at ?? chat.updated_at).toISOString(), updatedAt: new Date(chat.updated_at).toISOString() });
  }
  const boundary = query.cursor ? JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as { updatedAt: string; id: string } : null;
  const filtered = items.filter((item) => (!query.channel || item.channel === query.channel) && (!boundary ||
    item.updatedAt < boundary.updatedAt || item.updatedAt === boundary.updatedAt && item.id.localeCompare(boundary.id) < 0))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const page = filtered.slice(0, 50);
  const last = page.at(-1);
  return { items: page, nextCursor: filtered.length > page.length && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null };
}

const BASE = Date.parse('2026-10-01T00:00:00.000Z');

function seed() {
  // Ids mix case and separators so that localeCompare and binary order disagree.
  const prefixes = ['aex_', 'AEX-', 'aex-', 'Aex_'];
  for (let index = 0; index < 140; index += 1) {
    // Groups of up to 7 conversations share one updatedAt, so ties cross page boundaries.
    const at = new Date(BASE + Math.floor(index / 7) * 1000);
    const id = `${prefixes[index % prefixes.length]}${String(index).padStart(3, '0')}`;
    db.insert(agentExecutions).values({ id, workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, status: index % 11 === 0 ? 'failed' : 'completed',
      displayMessages: [{ id: `m_${id}`, role: 'user', content: index % 5 === 0 ? `需要部署 ${index}` : `问题 ${index}`, createdAt: at.toISOString() }], createdAt: at, updatedAt: at }).run();
  }
  db.insert(externalChats).values([
    { id: 'oc_bound', workspaceId: WORKSPACE_ID, channel: 'feishu', externalId: 'oc_bound', userId: 'u1', executionId: 'aex_004', updatedAt: new Date(BASE) },
    { id: 'wechat:bound', workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: 'wx_bound', userId: 'u2', executionId: 'AEX-005', updatedAt: new Date(BASE) },
    { id: 'oc_waiting', workspaceId: WORKSPACE_ID, channel: 'feishu', externalId: 'oc_waiting', userId: 'u3', updatedAt: new Date(BASE + 3000) },
    { id: 'wechat:waiting', workspaceId: WORKSPACE_ID, channel: 'wechat', externalId: 'wx_waiting', userId: 'u4', updatedAt: new Date(BASE + 9000) },
  ]).run();
  const target = { kind: 'conversation' as const };
  db.insert(chatSubmissions).values([
    { id: 'message:bound-1', workspaceId: WORKSPACE_ID, chatId: 'oc_bound', executionId: 'aex_004', message: 'hi', target, createdAt: new Date(BASE) },
    { id: 'message:bound-2', workspaceId: WORKSPACE_ID, chatId: 'wechat:bound', executionId: 'AEX-005', message: 'hi', target, createdAt: new Date(BASE) },
  ]).run();
  for (let index = 0; index < 12; index += 1) {
    const at = new Date(BASE + (index % 4) * 1000);
    db.insert(chatSubmissions).values({ id: `web_task_${index}`, workspaceId: WORKSPACE_ID, message: index % 3 === 0 ? `部署任务 ${index}` : `任务 ${index}`, target, reference: { kind: 'project_task', taskId: `t${index}` } as never, error: index === 2 ? 'boom' : null, createdAt: at, updatedAt: at }).run();
  }
  db.insert(feishuEvents).values([
    { id: 'message:om_1', chatId: 'oc_waiting', payload: { text: '等待中的部署问题' }, status: 'queued', createdAt: new Date(BASE + 2000) },
    ...Array.from({ length: 30 }, (_, index) => ({ id: `outbound:delivery:${index}:failed`, chatId: 'oc_waiting', payload: { direction: 'outbound', operation: 'card.card' }, status: 'failed' as const, error: 'rejected', createdAt: new Date(BASE + 2500 + index) })),
  ]).run();
  db.insert(wechatEvents).values([
    { id: 'message:wx_1', chatId: 'wechat:waiting', payload: { text: '微信消息' }, status: 'failed', createdAt: new Date(BASE + 8000) },
    { id: 'outbound:wx:1:done', chatId: 'wechat:waiting', payload: { direction: 'outbound', operation: 'message.send', text: '回复' }, status: 'done', createdAt: new Date(BASE + 8500) },
  ]).run();
}

async function walk(query: { search?: string; channel?: string }) {
  const pages: Array<{ items: ChatConversationSummary[]; nextCursor: string | null }> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await service.list(request, { ...query, cursor });
    expect(page).toEqual(previousList({ ...query, cursor }));
    pages.push(page);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}

describe('ChatConversationsService.list paging', () => {
  it('returns the same pages as the full-scan algorithm across sources and tied timestamps', async () => {
    seed();
    const pages = await walk({});
    const ids = pages.flatMap((page) => page.items.map((item) => item.id));
    expect(ids).toHaveLength(140 + 12 + 2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages.length).toBeGreaterThan(2);
  });

  it('keeps channel filtering exact for web, feishu and wechat', async () => {
    seed();
    const web = (await walk({ channel: 'web' })).flatMap((page) => page.items);
    expect(web.every((item) => item.channel === 'web')).toBe(true);
    const feishu = (await walk({ channel: 'feishu' })).flatMap((page) => page.items.map((item) => item.id));
    expect(feishu.sort()).toEqual(['aex_004', 'oc_waiting']);
    const wechat = (await walk({ channel: 'wechat' })).flatMap((page) => page.items.map((item) => item.id));
    expect(wechat.sort()).toEqual(['AEX-005', 'wechat:waiting']);
  });

  it('keeps search results identical', async () => {
    seed();
    const found = (await walk({ search: '部署' })).flatMap((page) => page.items.map((item) => item.id));
    expect(found).toContain('oc_waiting');
    expect(found).toContain('web_task_0');
    expect(found.length).toBe(28 + 4 + 1);
  });

  it('starts a page exactly at a cursor taken from inside a tie group', async () => {
    seed();
    const all = (await walk({})).flatMap((page) => page.items);
    for (const index of [3, 49, 50, 77, 101]) {
      const pivot = all[index];
      const cursor = Buffer.from(JSON.stringify({ updatedAt: pivot.updatedAt, id: pivot.id })).toString('base64url');
      const page = await service.list(request, { cursor });
      expect(page).toEqual(previousList({ cursor }));
      expect(page.items[0]?.id).toBe(all[index + 1]?.id);
    }
  });

  it('rejects malformed cursors', async () => {
    await expect(service.list(request, { cursor: 'nope' })).rejects.toThrow('Invalid conversation cursor.');
    const badDate = Buffer.from(JSON.stringify({ updatedAt: 'not-a-date', id: 'x' })).toString('base64url');
    await expect(service.list(request, { cursor: badDate })).rejects.toThrow('Invalid conversation cursor.');
  });
});
