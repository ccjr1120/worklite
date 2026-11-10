import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareGatewayDatabase,
  recordRequestLog,
  recordRequestStat,
  requestLogs,
  requestLog,
  requestStats,
} from './provider-registry';

const originalDatabasePath = process.env.PORTKEY_GATEWAY_DB_PATH;
const testDirectory = mkdtempSync(join(tmpdir(), 'worklite-usage-registry-'));
const testDatabasePath = join(testDirectory, 'gateway.db');

describe('gateway usage storage', () => {
  beforeAll(() => {
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
      CREATE TABLE gateway_request_logs (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        streaming INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        workflow_run_id TEXT,
        node_run_id TEXT,
        team_task_attempt_id TEXT,
        team_operation_key TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        request_body TEXT,
        response_kind TEXT NOT NULL,
        response_body TEXT
      );
    `);
    legacyDatabase
      .prepare(
        `INSERT INTO gateway_request_stats (
      occurred_at, provider_name, model, endpoint, status, duration_ms,
      prompt_tokens, completion_tokens, total_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        1,
        'legacy-provider',
        'legacy-model',
        '/v1/messages',
        200,
        3,
        33,
        4,
        37
      );
    legacyDatabase.close();

    process.env.PORTKEY_GATEWAY_DB_PATH = testDatabasePath;
    prepareGatewayDatabase();
  });

  afterAll(() => {
    if (originalDatabasePath === undefined)
      delete process.env.PORTKEY_GATEWAY_DB_PATH;
    else process.env.PORTKEY_GATEWAY_DB_PATH = originalDatabasePath;
    rmSync(testDirectory, { recursive: true, force: true });
  });

  it('extends the old schema without rewriting legacy rows and returns normalized values', () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    recordRequestStat({
      provider: 'openai',
      model: 'test-model',
      endpoint: '/v1/chat/completions',
      status: 200,
      durationMs: 12,
      promptTokens: 100,
      inputTokenSemantics: 'total',
      cacheReadTokens: 70,
      cacheCreationTokens: 0,
      completionTokens: 5,
      totalTokens: 105,
    });
    recordRequestLog({
      id: 'glog_usage_test',
      provider: 'openai',
      model: 'test-model',
      endpoint: '/v1/chat/completions',
      status: 200,
      durationMs: 12,
      streaming: false,
      promptTokens: 100,
      inputTokenSemantics: 'total',
      cacheReadTokens: 70,
      cacheCreationTokens: 0,
      completionTokens: 5,
      totalTokens: 105,
      request: { model: 'test-model' },
      response: { kind: 'json', body: { usage: { prompt_tokens: 100 } } },
    });

    const verificationDatabase = new BetterSqlite3(testDatabasePath, {
      readonly: true,
    });
    const legacyRow = verificationDatabase
      .prepare(
        'SELECT prompt_tokens, input_token_semantics, cache_read_tokens, cache_creation_tokens, completion_tokens, total_tokens FROM gateway_request_stats WHERE provider_name = ?'
      )
      .get('legacy-provider');
    verificationDatabase.close();
    expect(legacyRow).toEqual({
      prompt_tokens: 33,
      input_token_semantics: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      completion_tokens: 4,
      total_tokens: 37,
    });

    const stats = requestStats({ from, to });
    expect(stats.summary).toEqual(
      expect.objectContaining({
        promptTokens: 30,
        completionTokens: 5,
        cacheReadTokens: 70,
        cacheCreationTokens: 0,
        totalTokens: 105,
        usageRequests: 1,
      })
    );

    const logs = requestLogs({ from, to });
    expect(logs.items[0]).toEqual(
      expect.objectContaining({
        id: 'glog_usage_test',
        promptTokens: 30,
        completionTokens: 5,
        cacheReadTokens: 70,
        cacheCreationTokens: 0,
        totalTokens: 105,
      })
    );

    // WorkLite names models as <provider>/<model>; the stored row keeps them apart.
    expect(requestLogs({ from, to, model: 'openai/test-model' }).items.map((item) => item.id)).toEqual(['glog_usage_test']);
    expect(requestLogs({ from, to, model: 'test-model' }).items.map((item) => item.id)).toEqual(['glog_usage_test']);
    expect(requestLogs({ from, to, model: 'other/test-model' }).items).toEqual([]);
  });
  it('compresses full bodies losslessly and leaves expiry writes to maintenance', () => {
    const request = { messages: [{ role: 'user', content: '长上下文 '.repeat(10000) }] };
    const response = { kind: 'text' as const, body: '完整响应 '.repeat(10000) };
    recordRequestLog({ id: 'glog_packed', provider: 'packed', model: 'test', endpoint: '/responses', status: 200, durationMs: 1, streaming: false, request, response });
    expect(requestLog('glog_packed')).toEqual(expect.objectContaining({ request, response }));
    const db = new BetterSqlite3(testDatabasePath);
    try {
      const stored = db.prepare('SELECT request_body, response_body FROM gateway_request_logs WHERE id=?').get('glog_packed') as { request_body: string; response_body: string };
      expect(stored.request_body.length).toBeLessThan(JSON.stringify(request).length / 10);
      expect(stored.response_body.length).toBeLessThan(response.body.length / 10);
      db.prepare('UPDATE gateway_request_logs SET occurred_at=? WHERE id=?').run(Date.now()-13*3600000, 'glog_packed');
      expect(requestLog('glog_packed')).toBeNull();
      expect(requestLogs({ from: new Date(Date.now()-24*3600000).toISOString(), to: new Date().toISOString() }).items.some((item) => item.id === 'glog_packed')).toBe(false);
      expect(db.prepare('SELECT id FROM gateway_request_logs WHERE id=?').get('glog_packed')).toEqual({ id: 'glog_packed' });
    } finally { db.close(); }
  });

});
