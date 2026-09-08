import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { codexAuthStatus } from './codex-auth';
import { codexModels } from './codex-transport';

export type GatewayProviderProtocol = 'openai/chat' | 'openai/responses' | 'codex/responses' | 'deepseek/chat';

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

export type GatewayStatsWindow = '24h' | '7d' | '30d';

export type GatewayStats = {
  window: GatewayStatsWindow;
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

const VALID_PROTOCOLS: GatewayProviderProtocol[] = ['openai/chat', 'openai/responses', 'codex/responses', 'deepseek/chat'];
const GATEWAY_PROVIDER_ID = 'gateway-provider';
const CODEX_PROVIDER_ID = 'codex-provider';
const CODEX_PROVIDER_NAME = 'codex';
const CODEX_PROVIDER_BASE_URL = 'https://chatgpt.com/backend-api/codex';
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
  `);
  return database;
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
  return provider.protocol === 'codex/responses'
    ? codexAuthStatus().status === 'connected'
    : Boolean(provider.apiKey);
}

function view(provider: GatewayProvider): GatewayProviderView {
  return { id: provider.id, name: provider.name, protocol: provider.protocol, baseURL: provider.baseURL, models: provider.models, updatedAt: provider.updatedAt, status: configured(provider) ? 'connected' : 'unconfigured', maskedKey: provider.apiKey ? maskSecret(provider.apiKey) : '', headerNames: Object.keys(provider.headers ?? {}) };
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
    let models = current?.models ?? [];
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

function windowMs(window: GatewayStatsWindow): number {
  return window === '24h' ? 24 * 60 * 60 * 1000 : window === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
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

export function requestStats(window: GatewayStatsWindow = '24h'): GatewayStats {
  const toMs = Date.now();
  const fromMs = toMs - windowMs(window);
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
    window,
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
