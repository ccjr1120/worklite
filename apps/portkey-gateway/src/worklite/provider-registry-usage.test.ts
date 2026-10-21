import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareGatewayDatabase,
  recordRequestLog,
  recordRequestStat,
  requestLogs,
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
  });
});
