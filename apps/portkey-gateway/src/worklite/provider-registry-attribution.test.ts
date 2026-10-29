import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttribution, type GatewayAttribution } from './attribution';
import {
  prepareGatewayDatabase,
  recordRequestStat,
  requestStats,
} from './provider-registry';

const originalDatabasePath = process.env.PORTKEY_GATEWAY_DB_PATH;
const testDirectory = mkdtempSync(join(tmpdir(), 'worklite-attribution-registry-'));
const testDatabasePath = join(testDirectory, 'gateway.db');

function attribution(headers: Record<string, string>): GatewayAttribution {
  return readAttribution((name) => headers[name] ?? null);
}

function stat(headers: Record<string, string>, tokens: number): void {
  recordRequestStat({
    provider: 'openai',
    model: 'test-model',
    endpoint: '/v1/messages',
    status: 200,
    durationMs: 10,
    promptTokens: tokens,
    inputTokenSemantics: 'fresh',
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: 0,
    totalTokens: tokens,
    attribution: attribution(headers),
  });
}

describe('gateway usage attribution', () => {
  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();

  beforeAll(() => {
    // A pre-attribution statistics table, so the migration path and the handling of
    // rows that were recorded before surfaces existed are both exercised.
    const legacyDatabase = new BetterSqlite3(testDatabasePath);
    legacyDatabase.exec(`
      CREATE TABLE gateway_request_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER
      );
    `);
    legacyDatabase
      .prepare('INSERT INTO gateway_request_stats (occurred_at, provider_name, model, endpoint, status, duration_ms, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), 'legacy-provider', 'legacy-model', '/v1/messages', 200, 3, 10, 2, 12);
    legacyDatabase.close();

    process.env.PORTKEY_GATEWAY_DB_PATH = testDatabasePath;
    prepareGatewayDatabase();

    stat({ 'x-worklite-surface': 'chat', 'x-worklite-conversation-id': 'aex_one' }, 100);
    stat({ 'x-worklite-surface': 'chat', 'x-worklite-conversation-id': 'aex_two' }, 200);
    stat({
      'x-worklite-surface': 'chat_project_task',
      'x-worklite-conversation-id': 'aex_one',
      'x-worklite-project-task-id': 'acall_one',
      'x-worklite-executor': 'claude',
    }, 400);
    stat({
      'x-worklite-surface': 'executor_category',
      'x-worklite-team-id': 'team_one',
      'x-worklite-team-run-id': 'atrun_one',
      'x-worklite-team-role': 'developer',
    }, 800);
  });

  afterAll(() => {
    if (originalDatabasePath === undefined) delete process.env.PORTKEY_GATEWAY_DB_PATH;
    else process.env.PORTKEY_GATEWAY_DB_PATH = originalDatabasePath;
    rmSync(testDirectory, { recursive: true, force: true });
  });

  it('resolves a surface from the legacy source header and falls back to unattributed', () => {
    expect(attribution({ 'x-worklite-log-source': 'executor_category' }).surface).toBe('executor_category');
    expect(attribution({ 'x-worklite-log-source': 'proxy' }).surface).toBe('external');
    // An explicit surface wins over a coarser legacy source that cannot express it.
    expect(attribution({ 'x-worklite-log-source': 'chat', 'x-worklite-surface': 'chat_project_task' }).surface).toBe('chat_project_task');
    expect(attribution({}).surface).toBe('unattributed');
  });

  it('groups every request by surface and reports pre-attribution rows as unattributed', () => {
    const stats = requestStats({ from, to, groupBy: 'surface' });
    expect(stats.attribution.groupBy).toBe('surface');
    const bySurface = new Map(stats.attribution.groups.map((group) => [group.surface, group]));
    expect(bySurface.get('chat')).toEqual(expect.objectContaining({ requests: 2, totalTokens: 300 }));
    expect(bySurface.get('chat_project_task')).toEqual(expect.objectContaining({ requests: 1, totalTokens: 400 }));
    expect(bySurface.get('executor_category')).toEqual(expect.objectContaining({ requests: 1, totalTokens: 800 }));
    expect(bySurface.get('unattributed')).toEqual(expect.objectContaining({ requests: 1, totalTokens: 12 }));
    // Surface grouping is total, so its requests add up to the unfiltered summary.
    expect(stats.attribution.groups.reduce((sum, group) => sum + group.requests, 0)).toBe(stats.summary.requests);
  });

  it('keeps a conversation model loop and its project tasks in separate groups', () => {
    const stats = requestStats({ from, to, groupBy: 'conversation' });
    const tokensBySurface = new Map(stats.attribution.groups
      .filter((group) => group.conversationId === 'aex_one')
      .map((group) => [group.surface, group.totalTokens]));
    expect(tokensBySurface.get('chat')).toBe(100);
    expect(tokensBySurface.get('chat_project_task')).toBe(400);
    expect(tokensBySurface.size).toBe(2);
    // Team traffic has no conversation, so it is absent rather than collected into a
    // null-keyed row that reads like a real conversation.
    expect(stats.attribution.groups.every((group) => group.conversationId !== null)).toBe(true);
  });

  it('narrows statistics to one surface and one conversation', () => {
    const scoped = requestStats({ from, to, groupBy: 'conversation', conversationId: 'aex_one' });
    expect(scoped.summary.requests).toBe(2);
    expect(scoped.summary.totalTokens).toBe(500);

    const chatOnly = requestStats({ from, to, surface: 'chat' });
    expect(chatOnly.summary.requests).toBe(2);
    expect(chatOnly.summary.totalTokens).toBe(300);
  });

  it('groups Team and executor usage only where that identifier is present', () => {
    const byTeam = requestStats({ from, to, groupBy: 'executor_category' });
    expect(byTeam.attribution.groups).toEqual([
      expect.objectContaining({ executorCategoryId: 'team_one', teamRunId: 'atrun_one', requests: 1, totalTokens: 800 }),
    ]);

    const byExecutor = requestStats({ from, to, groupBy: 'executor' });
    expect(byExecutor.attribution.groups).toEqual([
      expect.objectContaining({ surface: 'chat_project_task', executor: 'claude', requests: 1, totalTokens: 400 }),
    ]);
  });
});
