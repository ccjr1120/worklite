import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { codexAuthStatus } from './codex-auth';
import { codexModels } from './codex-transport';

export type GatewayProviderProtocol = 'openai/chat' | 'openai/responses' | 'anthropic/messages' | 'codex/responses' | 'typesafe/systemone';

export type GatewayProvider = {
  id: string;
  name: string;
  protocol: GatewayProviderProtocol;
  baseURL: string;
  apiKey: string;
  models: string[];
  headers?: Record<string, string>;
  updatedAt: string;
};

export type GatewayProviderView = Omit<GatewayProvider, 'apiKey' | 'headers'> & {
  status: 'connected' | 'unconfigured' | 'invalid';
  maskedKey: string;
  headerNames: string[];
};

export type GatewayTimeRangeQuery = {
  from?: string;
  to?: string;
};

export type GatewayStats = {
  from: string;
  to: string;
  summary: {
    requests: number;
    successful: number;
    failed: number;
    successRate: number | null;
    averageLatencyMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    usageRequests: number;
  };
  breakdown: Array<{
    provider: string;
    model: string;
    requests: number;
    successful: number;
    failed: number;
    averageLatencyMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    usageRequests: number;
    endpoints: Array<{ endpoint: string; requests: number }>;
    statuses: Array<{ status: number; requests: number }>;
  }>;
};

type ProviderRow = {
  id: string;
  name: string;
  base_url: string | null;
  protocol: GatewayProviderProtocol;
  models: string;
  api_key: string | null;
  headers: string | null;
  updated_at: number | string | null;
};

const VALID_PROTOCOLS: GatewayProviderProtocol[] = ['openai/chat', 'openai/responses', 'anthropic/messages', 'codex/responses', 'typesafe/systemone'];
const GATEWAY_PROVIDER_ID = 'gateway-provider';
const CODEX_PROVIDER_ID = 'codex-provider';
const CODEX_PROVIDER_NAME = 'codex';
const CODEX_PROVIDER_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_IMAGE_MODEL_ID = 'gpt-image-2';
let database: BetterSqlite3.Database | null = null;
let codexSyncPromise: Promise<void> | null = null;
let codexSyncedAt = 0;

function databasePath(): string {
  const configured = process.env.PORTKEY_GATEWAY_DB_PATH?.trim();
  return configured ? resolve(process.cwd(), configured) : resolve(process.cwd(), 'data/worklite-gateway.db');
}

function getDatabase(): BetterSqlite3.Database {
  if (database) return database;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  database = new BetterSqlite3(path);
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS gateway_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT,
      protocol TEXT NOT NULL DEFAULT 'openai/chat',
      status TEXT NOT NULL DEFAULT 'unconfigured',
      masked_key TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      api_key TEXT,
      headers TEXT,
      updated_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gateway_providers_name_idx ON gateway_providers(name);
    CREATE TABLE IF NOT EXISTS gateway_request_stats (
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
    CREATE INDEX IF NOT EXISTS gateway_request_stats_occurred_idx ON gateway_request_stats(occurred_at);
    CREATE INDEX IF NOT EXISTS gateway_request_stats_provider_model_idx ON gateway_request_stats(provider_name, model);
    CREATE TABLE IF NOT EXISTS gateway_request_logs (
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
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      request_body TEXT,
      response_kind TEXT NOT NULL,
      response_body TEXT
    );
    CREATE INDEX IF NOT EXISTS gateway_request_logs_occurred_idx ON gateway_request_logs(occurred_at);
    CREATE INDEX IF NOT EXISTS gateway_request_logs_provider_model_idx ON gateway_request_logs(provider_name, model);
    CREATE INDEX IF NOT EXISTS gateway_request_logs_workflow_run_idx ON gateway_request_logs(workflow_run_id);
  `);
  pruneRequestLogs(database);
  return database;
}

const REQUEST_LOG_RETENTION_DAYS = 3;
const REQUEST_LOG_RETENTION_MS = REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function pruneRequestLogs(target: BetterSqlite3.Database): void {
  target.prepare('DELETE FROM gateway_request_logs WHERE occurred_at < ?').run(Date.now() - REQUEST_LOG_RETENTION_MS);
}

function secretKey(): Buffer {
  return createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
}

function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey() as unknown as Uint8Array<ArrayBufferLike>, iv as unknown as Uint8Array<ArrayBufferLike>);
  const encrypted = cipher.update(value, 'utf8', 'base64') + cipher.final('base64');
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted}`;
}

function decryptSecret(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', secretKey() as unknown as Uint8Array<ArrayBufferLike>, Buffer.from(ivValue, 'base64url') as unknown as Uint8Array<ArrayBufferLike>);
  decipher.setAuthTag(new Uint8Array(Buffer.from(tagValue, 'base64url')));
  return decipher.update(encryptedValue, 'base64', 'utf8') + decipher.final('utf8');
}

function readSecret(value: string | null): string {
  if (!value) return '';
  try { return decryptSecret(value); } catch { return value; }
}

function parseModels(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? [...new Set(parsed.filter((model): model is string => typeof model === 'string').map((model) => model.trim()).filter(Boolean))] : [];
  } catch {
    return [];
  }
}

function parseHeaders(value: string | null): Record<string, string> | undefined {
  const raw = readSecret(value);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter(([, header]) => typeof header === 'string').map(([name, header]) => [name, header as string]))
      : undefined;
  } catch {
    return undefined;
  }
}

function updatedAt(value: number | string | null): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string' && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

function providerFromRow(row: ProviderRow): GatewayProvider {
  const headers = parseHeaders(row.headers);
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseURL: row.base_url ?? '',
    apiKey: readSecret(row.api_key),
    models: parseModels(row.models),
    ...(headers ? { headers } : {}),
    updatedAt: updatedAt(row.updated_at),
  };
}

function maskSecret(value: string): string {
  return value.length > 4 ? `****${value.slice(-4)}` : '****';
}

function configured(provider: GatewayProvider): boolean {
  if (!VALID_PROTOCOLS.includes(provider.protocol)) return false;
  return provider.protocol === 'codex/responses'
    ? codexAuthStatus().status === 'connected'
    : Boolean(provider.apiKey);
}

function view(provider: GatewayProvider): GatewayProviderView {
  const status = !VALID_PROTOCOLS.includes(provider.protocol) ? 'invalid' : configured(provider) ? 'connected' : 'unconfigured';
  return { id: provider.id, name: provider.name, protocol: provider.protocol, baseURL: provider.baseURL, models: provider.models, updatedAt: provider.updatedAt, status, maskedKey: provider.apiKey ? maskSecret(provider.apiKey) : '', headerNames: Object.keys(provider.headers ?? {}) };
}

function validateInput(input: unknown, partial = false): Partial<GatewayProvider> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider configuration must be an object.');
  const value = input as Record<string, unknown>;
  const result: Partial<GatewayProvider> = {};
  if (!partial || 'name' in value) {
    if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('Provider name is required.');
    result.name = value.name.trim();
    if (result.name.includes('/')) throw new Error('Provider name cannot contain "/".');
  }
  if (!partial || 'baseURL' in value) {
    if (typeof value.baseURL !== 'string' || !value.baseURL.trim()) throw new Error('Base URL is required.');
    result.baseURL = value.baseURL.trim();
  }
  if (!partial || 'protocol' in value) {
    if (!VALID_PROTOCOLS.includes(value.protocol as GatewayProviderProtocol)) throw new Error('Unsupported model provider protocol.');
    result.protocol = value.protocol as GatewayProviderProtocol;
  }
  if (!partial || 'models' in value) {
    if (!Array.isArray(value.models) || value.models.some((model) => typeof model !== 'string')) throw new Error('Models must be an array of strings.');
    result.models = [...new Set(value.models.map((model) => model.trim()).filter(Boolean))];
  }
  if ('apiKey' in value && value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string') throw new Error('API key must be a string.');
    result.apiKey = value.apiKey.trim();
  }
  if ('headers' in value && value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) || Object.values(value.headers).some((header) => typeof header !== 'string')) throw new Error('Custom headers must be an object with string values.');
    result.headers = Object.fromEntries(Object.entries(value.headers).map(([name, header]) => [name.trim().toLowerCase(), header as string]));
  }
  return result;
}

function rows(): GatewayProvider[] {
  const records = getDatabase().prepare('SELECT id, name, base_url, protocol, models, api_key, headers, updated_at FROM gateway_providers WHERE id <> ? ORDER BY name').all(GATEWAY_PROVIDER_ID) as ProviderRow[];
  const codexConfigured = codexAuthStatus().status === 'connected';
  return records.map(providerFromRow).filter((provider) => !isAutomaticCodexProvider(provider) || codexConfigured);
}

function isAutomaticCodexProvider(provider: Pick<GatewayProvider, 'id' | 'name' | 'protocol'>): boolean {
  return provider.id === CODEX_PROVIDER_ID || (provider.name === CODEX_PROVIDER_NAME && provider.protocol === 'codex/responses');
}

async function syncCodexProvider(): Promise<void> {
  if (codexAuthStatus().status !== 'connected') return;
  if (codexSyncPromise) return codexSyncPromise;
  if (Date.now() - codexSyncedAt < 30_000) return;
  codexSyncPromise = (async () => {
    const database = getDatabase();
    const row = database.prepare("SELECT id, name, base_url, protocol, models, api_key, headers, updated_at FROM gateway_providers WHERE id = ? OR (name = ? AND protocol = 'codex/responses') ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1").get(CODEX_PROVIDER_ID, CODEX_PROVIDER_NAME, CODEX_PROVIDER_ID) as ProviderRow | undefined;
    const current = row ? providerFromRow(row) : undefined;
    if (!current && database.prepare('SELECT 1 FROM gateway_providers WHERE name = ?').get(CODEX_PROVIDER_NAME)) {
      codexSyncedAt = Date.now();
      return;
    }
    let models = [...new Set([...current?.models ?? [], CODEX_IMAGE_MODEL_ID])];
    try {
      const response = await codexModels(new Request('http://127.0.0.1/v1/models'));
      if (response.ok) {
        const payload = await response.json() as { data?: unknown };
        if (Array.isArray(payload.data)) {
          models = [...new Set(payload.data.flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const id = (item as Record<string, unknown>).id;
            return typeof id === 'string' && id.trim() ? [id.trim()] : [];
          }))];
          models = [...new Set([...models, CODEX_IMAGE_MODEL_ID])];
        }
      }
    } catch {
      // Keep the last known model catalog when the Codex endpoint is unavailable.
    }
    const id = current?.id ?? CODEX_PROVIDER_ID;
    const baseURL = process.env.CODEX_UPSTREAM_URL?.trim() || CODEX_PROVIDER_BASE_URL;
    const values: GatewayProvider = { id, name: CODEX_PROVIDER_NAME, protocol: 'codex/responses', baseURL, apiKey: '', models, updatedAt: new Date().toISOString() };
    if (current) {
      database.prepare('UPDATE gateway_providers SET name = ?, base_url = ?, protocol = ?, status = ?, masked_key = ?, models = ?, api_key = NULL, headers = NULL, updated_at = ? WHERE id = ?').run(values.name, values.baseURL, values.protocol, 'connected', '', JSON.stringify(values.models), Date.now(), id);
    } else {
      database.prepare('INSERT INTO gateway_providers (id, name, base_url, protocol, status, masked_key, models, api_key, headers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)').run(values.id, values.name, values.baseURL, values.protocol, 'connected', '', JSON.stringify(values.models), Date.now());
    }
    codexSyncedAt = Date.now();
  })().finally(() => { codexSyncPromise = null; });
  return codexSyncPromise;
}

export async function listProviders(): Promise<GatewayProviderView[]> {
  await syncCodexProvider();
  return rows().map(view);
}

export async function createProvider(input: unknown): Promise<GatewayProviderView> {
  const values = validateInput(input);
  const provider: GatewayProvider = { id: `prov_${randomUUID()}`, name: values.name!, protocol: values.protocol!, baseURL: values.baseURL!, apiKey: values.protocol === 'codex/responses' ? '' : values.apiKey ?? '', models: values.models ?? [], ...(values.headers ? { headers: values.headers } : {}), updatedAt: new Date().toISOString() };
  if (provider.name === CODEX_PROVIDER_NAME) throw new Error('The codex Provider is managed automatically by the Gateway.');
  const db = getDatabase();
  if (rows().some((candidate) => candidate.name === provider.name)) throw new Error('A provider with this name already exists.');
  db.prepare('INSERT INTO gateway_providers (id, name, base_url, protocol, status, masked_key, models, api_key, headers, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(provider.id, provider.name, provider.baseURL, provider.protocol, configured(provider) ? 'connected' : 'unconfigured', provider.apiKey ? maskSecret(provider.apiKey) : '', JSON.stringify(provider.models), provider.apiKey ? encryptSecret(provider.apiKey) : null, provider.headers ? encryptSecret(JSON.stringify(provider.headers)) : null, Date.now());
  return view(provider);
}

export async function updateProvider(id: string, input: unknown): Promise<GatewayProviderView> {
  const current = await getProvider(id);
  if (!current) throw new Error('Model provider not found.');
  if (isAutomaticCodexProvider(current)) throw new Error('The codex Provider is managed automatically by the Gateway.');
  const values = validateInput(input, true);
  if (values.name === CODEX_PROVIDER_NAME) throw new Error('The codex Provider is managed automatically by the Gateway.');
  if (values.name && rows().some((provider) => provider.id !== id && provider.name === values.name)) throw new Error('A provider with this name already exists.');
  const provider: GatewayProvider = { ...current, ...values, updatedAt: new Date().toISOString() };
  const apiKey = provider.protocol === 'codex/responses' ? '' : values.apiKey === undefined ? current.apiKey : provider.apiKey;
  const headers = values.headers === undefined ? current.headers : provider.headers;
  getDatabase().prepare('UPDATE gateway_providers SET name = ?, base_url = ?, protocol = ?, status = ?, masked_key = ?, models = ?, api_key = ?, headers = ?, updated_at = ? WHERE id = ?').run(provider.name, provider.baseURL, provider.protocol, configured({ ...provider, apiKey, ...(headers ? { headers } : {}) }) ? 'connected' : 'unconfigured', apiKey ? maskSecret(apiKey) : '', JSON.stringify(provider.models), apiKey ? encryptSecret(apiKey) : null, headers ? encryptSecret(JSON.stringify(headers)) : null, Date.now(), id);
  return view({ ...provider, apiKey, ...(headers ? { headers } : {}) });
}

export async function deleteProvider(id: string): Promise<void> {
  const row = getDatabase().prepare('SELECT id, name, base_url, protocol, models, api_key, headers, updated_at FROM gateway_providers WHERE id = ?').get(id) as ProviderRow | undefined;
  const current = row ? providerFromRow(row) : undefined;
  if (current && isAutomaticCodexProvider(current)) throw new Error('The codex Provider is managed automatically by the Gateway.');
  const result = getDatabase().prepare('DELETE FROM gateway_providers WHERE id = ? AND id <> ?').run(id, GATEWAY_PROVIDER_ID);
  if (result.changes === 0) throw new Error('Model provider not found.');
}

export async function getProvider(id: string): Promise<GatewayProvider | undefined> {
  if (id === GATEWAY_PROVIDER_ID) return undefined;
  const row = getDatabase().prepare('SELECT id, name, base_url, protocol, models, api_key, headers, updated_at FROM gateway_providers WHERE id = ?').get(id) as ProviderRow | undefined;
  if (!row) return undefined;
  const provider = providerFromRow(row);
  return isAutomaticCodexProvider(provider) && codexAuthStatus().status !== 'connected' ? undefined : provider;
}

export function providerView(provider: GatewayProvider): GatewayProviderView {
  return view(provider);
}

function nullableTotal(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

function parseInstant(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolves an explicit absolute range. An absent bound falls back to the last 24
 * hours ending now, `to` never runs past the current instant, and an inverted
 * range is rejected rather than silently swapped: a caller that sent the bounds
 * the wrong way round asked for something different from what swapping produces.
 */
export function resolveTimeRange(query: GatewayTimeRangeQuery = {}): { fromMs: number; toMs: number } {
  const now = Date.now();
  const requestedTo = parseInstant(query.to);
  const requestedFrom = parseInstant(query.from);
  const toMs = Math.min(requestedTo ?? now, now);
  const fromMs = requestedFrom ?? toMs - DEFAULT_RANGE_MS;
  if (fromMs > toMs) throw new RangeError('The range start must not be later than its end.');
  return { fromMs, toMs };
}

export function recordRequestStat(input: {
  provider: string;
  model: string;
  endpoint: string;
  status: number;
  durationMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}): void {
  getDatabase().prepare(`INSERT INTO gateway_request_stats (occurred_at, provider_name, model, endpoint, status, duration_ms, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), input.provider || 'Unknown', input.model || 'Unknown', input.endpoint || '/', input.status, Math.max(0, Math.round(input.durationMs)), input.promptTokens ?? null, input.completionTokens ?? null, input.totalTokens ?? null);
}

export function requestStats(query: GatewayTimeRangeQuery = {}): GatewayStats {
  const { fromMs, toMs } = resolveTimeRange(query);
  const records = getDatabase().prepare('SELECT provider_name, model, endpoint, status, duration_ms, prompt_tokens, completion_tokens, total_tokens FROM gateway_request_stats WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at DESC').all(fromMs, toMs) as Array<{ provider_name: string; model: string; endpoint: string; status: number; duration_ms: number; prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null }>;
  const successful = records.filter((record) => record.status >= 200 && record.status < 400).length;
  const summaryTokens = {
    promptTokens: nullableTotal(records.map((record) => record.prompt_tokens)),
    completionTokens: nullableTotal(records.map((record) => record.completion_tokens)),
    totalTokens: nullableTotal(records.map((record) => record.total_tokens)),
  };
  const groups = new Map<string, typeof records>();
  for (const record of records) {
    const key = `${record.provider_name}\u0000${record.model}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const breakdown = [...groups.values()].map((group) => {
    const groupSuccessful = group.filter((record) => record.status >= 200 && record.status < 400).length;
    const endpointCounts = new Map<string, number>();
    const statusCounts = new Map<number, number>();
    for (const record of group) {
      endpointCounts.set(record.endpoint, (endpointCounts.get(record.endpoint) ?? 0) + 1);
      statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
    }
    return {
      provider: group[0].provider_name,
      model: group[0].model,
      requests: group.length,
      successful: groupSuccessful,
      failed: group.length - groupSuccessful,
      averageLatencyMs: Math.round(group.reduce((total, record) => total + record.duration_ms, 0) / group.length),
      promptTokens: nullableTotal(group.map((record) => record.prompt_tokens)),
      completionTokens: nullableTotal(group.map((record) => record.completion_tokens)),
      totalTokens: nullableTotal(group.map((record) => record.total_tokens)),
      usageRequests: group.filter((record) => record.total_tokens !== null).length,
      endpoints: [...endpointCounts.entries()].map(([endpoint, requests]) => ({ endpoint, requests })),
      statuses: [...statusCounts.entries()].map(([status, requests]) => ({ status, requests })),
    };
  }).sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    summary: {
      requests: records.length,
      successful,
      failed: records.length - successful,
      successRate: records.length ? Math.round((successful / records.length) * 1000) / 10 : null,
      averageLatencyMs: records.length ? Math.round(records.reduce((total, record) => total + record.duration_ms, 0) / records.length) : null,
      ...summaryTokens,
      usageRequests: records.filter((record) => record.total_tokens !== null).length,
    },
    breakdown,
  };
}

export type GatewayRequestLogResponse =
  | { kind: 'json'; body: unknown }
  | { kind: 'text'; body: string }
  | { kind: 'stream'; events: unknown[] }
  | { kind: 'unavailable'; reason: string };

type GatewayRequestLogRow = {
  id: string;
  occurred_at: number;
  provider_name: string;
  model: string;
  endpoint: string;
  status: number;
  duration_ms: number;
  streaming: number;
  source: string | null;
  workflow_run_id: string | null;
  node_run_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  request_body: string | null;
  response_kind: string;
  response_body: string | null;
};

export function recordRequestLog(input: {
  id?: string | null;
  provider: string;
  model: string;
  endpoint: string;
  status: number;
  durationMs: number;
  streaming: boolean;
  source?: string | null;
  workflowRunId?: string | null;
  nodeRunId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  request: unknown;
  response: GatewayRequestLogResponse;
}): string {
  const database = getDatabase();
  const id = input.id?.trim() || `glog_${randomUUID()}`;
  database.prepare(`INSERT INTO gateway_request_logs (id, occurred_at, provider_name, model, endpoint, status, duration_ms, streaming, source, workflow_run_id, node_run_id, prompt_tokens, completion_tokens, total_tokens, request_body, response_kind, response_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    Date.now(),
    input.provider || 'Unknown',
    input.model || 'Unknown',
    input.endpoint || '/',
    input.status,
    Math.max(0, Math.round(input.durationMs)),
    input.streaming ? 1 : 0,
    input.source ?? null,
    input.workflowRunId ?? null,
    input.nodeRunId ?? null,
    input.promptTokens ?? null,
    input.completionTokens ?? null,
    input.totalTokens ?? null,
    safeJsonText(input.request),
    input.response.kind,
    responseBodyText(input.response),
  );
  pruneRequestLogs(database);
  return id;
}

function safeJsonText(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

function responseBodyText(response: GatewayRequestLogResponse): string | null {
  if (response.kind === 'text') return response.body;
  if (response.kind === 'unavailable') return response.reason;
  if (response.kind === 'stream') return safeJsonText(response.events);
  return safeJsonText(response.body);
}

function parseStoredJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requestLogResponse(row: GatewayRequestLogRow): GatewayRequestLogResponse {
  if (row.response_kind === 'text') return { kind: 'text', body: row.response_body ?? '' };
  if (row.response_kind === 'unavailable') return { kind: 'unavailable', reason: row.response_body ?? 'The response was not captured.' };
  if (row.response_kind === 'stream') {
    const events = parseStoredJson(row.response_body);
    return { kind: 'stream', events: Array.isArray(events) ? events : [] };
  }
  return { kind: 'json', body: parseStoredJson(row.response_body) };
}

function requestLogListItem(row: GatewayRequestLogRow) {
  return {
    id: row.id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    provider: row.provider_name,
    model: row.model,
    endpoint: row.endpoint,
    status: row.status,
    durationMs: row.duration_ms,
    streaming: row.streaming === 1,
    source: row.source,
    workflowRunId: row.workflow_run_id,
    nodeRunId: row.node_run_id,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
  };
}

const REQUEST_LOG_PAGE_LIMIT = 50;

export function requestLogs(query: GatewayTimeRangeQuery & {
  provider?: string;
  model?: string;
  statusClass?: string;
  workflowRunId?: string;
  limit?: number;
  cursor?: string;
}) {
  const database = getDatabase();
  pruneRequestLogs(database);
  const { fromMs, toMs } = resolveTimeRange(query);
  // Details live for three days while statistics live forever, so a range that
  // reaches further back is served as its intersection with the retention window.
  // The reader is told what was actually covered instead of being handed a
  // rejection for a range that is valid against the other store.
  const retainedFromMs = Date.now() - REQUEST_LOG_RETENTION_MS;
  const servedFromMs = Math.max(fromMs, retainedFromMs);
  const conditions: string[] = ['occurred_at >= ?', 'occurred_at <= ?'];
  const values: Array<string | number> = [servedFromMs, toMs];
  if (query.provider?.trim()) {
    conditions.push('provider_name = ?');
    values.push(query.provider.trim());
  }
  if (query.model?.trim()) {
    conditions.push('model = ?');
    values.push(query.model.trim());
  }
  if (query.workflowRunId?.trim()) {
    conditions.push('workflow_run_id = ?');
    values.push(query.workflowRunId.trim());
  }
  if (query.statusClass === 'success') conditions.push('status >= 200 AND status < 400');
  if (query.statusClass === 'client_error') conditions.push('status >= 400 AND status < 500');
  if (query.statusClass === 'server_error') conditions.push('status >= 500');
  const cursor = Number(query.cursor ?? '');
  if (Number.isSafeInteger(cursor) && cursor > 0) {
    conditions.push('occurred_at < ?');
    values.push(cursor);
  }
  const requested = Number(query.limit ?? REQUEST_LOG_PAGE_LIMIT);
  const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, REQUEST_LOG_PAGE_LIMIT) : REQUEST_LOG_PAGE_LIMIT;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = database.prepare(`SELECT * FROM gateway_request_logs ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(...values, limit + 1) as GatewayRequestLogRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(requestLogListItem),
    nextCursor: rows.length > limit && last ? String(last.occurred_at) : null,
    retentionDays: REQUEST_LOG_RETENTION_DAYS,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    retainedFrom: new Date(retainedFromMs).toISOString(),
  };
}

export function requestLog(requestLogId: string) {
  const database = getDatabase();
  pruneRequestLogs(database);
  const row = database.prepare('SELECT * FROM gateway_request_logs WHERE id = ?').get(requestLogId) as GatewayRequestLogRow | undefined;
  if (!row) return null;
  return { ...requestLogListItem(row), request: parseStoredJson(row.request_body), response: requestLogResponse(row) };
}
