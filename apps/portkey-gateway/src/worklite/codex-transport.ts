import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { acquireCodexAccount, acquireCodexAccountById, codexAuthStatus } from './codex-auth';

type RateLimitWindow = { usedPercent: number; limitWindowSeconds: number; resetsAt: string };
export type CodexRateLimitSnapshot = { planType: string | null; limits: Array<{ id: string; name: string | null; primary: RateLimitWindow | null; secondary: RateLimitWindow | null }> };
export type CodexAccountUsageSnapshot = { accounts: Array<{ accountId: string; status: 'connected' | 'disabled' | 'expired' | 'error' | 'unavailable'; planType: string | null; primary: RateLimitWindow | null; secondary: RateLimitWindow | null; fetchedAt: string | null; error?: string }>; fetchedAt: string };

type CodexConfig = {
  upstreamBaseURL: string;
  clientVersion: string;
  userAgent: string;
  originator: string;
  residency: string;
};

// Aligned with openai/codex rust-v0.166.0 (6ff1e1ca3b30fc8b914720681fcf5fe62e95f856).
// Upstream derives client_version from the crate version (models-manager client_version_to_whole) and builds
// the user agent as "<originator>/<version> (<os> <os version>; <arch>) <terminal>" (login default_client.rs);
// the OS and terminal part below is a representative value because a gateway has no client terminal.
const UPSTREAM_CODEX_VERSION = '0.166.0';
const UPSTREAM_USER_AGENT_PLATFORM = '(Mac OS 15.5.0; arm64) unknown';

function config(): CodexConfig {
  const clientVersion = process.env.CODEX_CLIENT_VERSION?.trim() || UPSTREAM_CODEX_VERSION;
  const originator = process.env.CODEX_ORIGINATOR?.trim() || 'codex_cli_rs';
  return {
    upstreamBaseURL: (process.env.CODEX_UPSTREAM_URL?.trim() || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, ''),
    clientVersion,
    userAgent: process.env.CODEX_USER_AGENT?.trim() || `${originator}/${clientVersion} ${UPSTREAM_USER_AGENT_PLATFORM}`,
    originator,
    residency: process.env.CODEX_RESIDENCY?.trim() || 'us',
  };
}

// Request headers the upstream Codex client attaches to Responses calls (core/src/client.rs,
// core/src/responses_metadata.rs, codex-api/src/requests/headers.rs); forwarded when the caller sends them.
const FORWARDED_REQUEST_HEADERS = [
  'openai-beta',
  'session-id',
  'thread-id',
  'x-codex-turn-state',
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-codex-parent-thread-id',
  'x-codex-beta-features',
  'x-codex-routing-hint',
  'x-openai-subagent',
  'x-openai-memgen-request',
  'x-openai-internal-codex-responses-lite',
  'x-oai-attestation',
];

// Response headers the upstream client reads (codex-api/src/sse/responses.rs, rate_limits.rs, endpoint/images.rs).
// Every x-codex-* header is also forwarded so per-limit rate-limit families and credits survive the proxy.
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'x-request-id',
  'x-oai-request-id',
  'openai-model',
  'x-openai-model',
  'x-reasoning-included',
  'openai-verification-recommendation',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
];

function unavailable(): Response {
  return json({ error: { message: 'Codex Provider is not configured.', type: 'configuration_error' } }, 503);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

// Default client headers (login/src/auth/default_client.rs default_headers) plus ChatGPT account routing.
function clientHeaders(accessToken: string, accountId: string | undefined, accept: string): Headers {
  const current = config();
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    accept,
    'user-agent': current.userAgent,
    originator: current.originator,
    'x-openai-internal-codex-residency': current.residency,
  });
  if (accountId) headers.set('chatgpt-account-id', accountId);
  return headers;
}

function upstreamHeaders(requestHeaders: Record<string, string>, accessToken: string, accountId: string | undefined, accept: string): Headers {
  const headers = clientHeaders(accessToken, accountId, accept);
  // Upstream uses the thread id as x-client-request-id; OpenAI-Beta responses_websockets is only sent on the
  // WebSocket handshake, so the HTTP transport forwards it only when the caller supplies it.
  headers.set('x-client-request-id', requestHeaders['x-client-request-id']?.trim() || requestHeaders['thread-id']?.trim() || `req_${randomUUID()}`);
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders[name]?.trim();
    if (value) headers.set(name, value);
  }
  return headers;
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith('x-codex-') && value) headers.set(name, value);
  });
  return headers;
}

function upstreamURL(pathname: string, search = ''): string {
  return `${config().upstreamBaseURL}${pathname}${search}`;
}

function usageURL(): string {
  const url = new URL(config().upstreamBaseURL);
  url.pathname = `${url.pathname.replace(/\/codex\/?$/, '')}/wham/usage`.replace(/\/{2,}/g, '/');
  url.search = '';
  return url.toString();
}

function rateLimitWindow(value: unknown): RateLimitWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  // RateLimitWindowSnapshot: used_percent, limit_window_seconds, reset_after_seconds, reset_at (epoch seconds).
  if (typeof row.used_percent !== 'number' || typeof row.limit_window_seconds !== 'number') return null;
  const resetAt = typeof row.reset_at === 'number' ? row.reset_at * 1000 : typeof row.reset_after_seconds === 'number' ? Date.now() + row.reset_after_seconds * 1000 : null;
  if (resetAt === null) return null;
  return { usedPercent: row.used_percent, limitWindowSeconds: row.limit_window_seconds, resetsAt: new Date(resetAt).toISOString() };
}

function rateLimit(value: unknown, id: string, name: string | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { id, name, primary: null, secondary: null };
  const row = value as Record<string, unknown>;
  return { id, name, primary: rateLimitWindow(row.primary_window), secondary: rateLimitWindow(row.secondary_window) };
}

async function fetchUsage(lease: Awaited<ReturnType<typeof acquireCodexAccountById>>): Promise<{ planType: string | null; primary: RateLimitWindow | null; secondary: RateLimitWindow | null }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = clientHeaders(lease.accessToken, lease.accountId, 'application/json');
    const response = await fetch(usageURL(), { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 && attempt === 0) { lease.accessToken = await lease.refresh(); continue; }
    if (!response.ok) throw new Error(`Codex usage request failed (${response.status}).`);
    const payload = await response.json() as Record<string, unknown>;
    const current = rateLimit(payload.rate_limit, 'codex', null);
    return {
      planType: typeof payload.plan_type === 'string' ? payload.plan_type : null,
      primary: current.primary,
      secondary: current.secondary,
    };
  }
  throw new Error('Codex authentication expired.');
}

export async function codexAccountUsages(): Promise<CodexAccountUsageSnapshot> {
  const accounts = codexAuthStatus().accounts;
  const usage = await Promise.all(accounts.map(async (account) => {
    if (!account.enabled) return { accountId: account.id, status: 'disabled' as const, planType: account.planType, primary: null, secondary: null, fetchedAt: null };
    let lease: Awaited<ReturnType<typeof acquireCodexAccountById>> | undefined;
    try {
      lease = await acquireCodexAccountById(account.id);
      const snapshot = await fetchUsage(lease);
      return { accountId: account.id, status: 'connected' as const, ...snapshot, fetchedAt: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Codex account usage is unavailable.';
      const status = /authentication expired|refresh|401/i.test(message) ? 'error' as const : 'unavailable' as const;
      return { accountId: account.id, status, planType: account.planType, primary: null, secondary: null, fetchedAt: null, error: message };
    } finally {
      lease?.release();
    }
  }));
  return { accounts: usage, fetchedAt: new Date().toISOString() };
}

export async function codexRateLimits(): Promise<CodexRateLimitSnapshot> {
  const lease = await acquireCodexAccount();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = clientHeaders(lease.accessToken, lease.accountId, 'application/json');
      const response = await fetch(usageURL(), { headers, signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 && attempt === 0) { lease.accessToken = await lease.refresh(); continue; }
      if (!response.ok) throw new Error(`Codex rate-limit request failed (${response.status}).`);
      const payload = await response.json() as Record<string, unknown>;
      const limits = [rateLimit(payload.rate_limit, 'codex', null)];
      if (Array.isArray(payload.additional_rate_limits)) payload.additional_rate_limits.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const row = item as Record<string, unknown>;
        // AdditionalRateLimitDetails: metered_feature is the limit id, limit_name the display name (backend-client client.rs).
        const id = [row.metered_feature, row.metered_limit_name, row.limit_name].find((item): item is string => typeof item === 'string' && Boolean(item)) ?? `additional_${index + 1}`;
        const name = [row.limit_name, row.metered_feature, row.metered_limit_name].find((item): item is string => typeof item === 'string' && Boolean(item)) ?? null;
        limits.push(rateLimit(row.rate_limit, id, name));
      });
      return { planType: typeof payload.plan_type === 'string' ? payload.plan_type : null, limits: limits.filter((limit) => limit.primary || limit.secondary) };
    }
    throw new Error('Codex authentication expired.');
  } finally { lease.release(); }
}
export async function codexModels(request: Request): Promise<Response> {
  const current = config();
  let lease;
  try { lease = await acquireCodexAccount(); } catch { return unavailable(); }
  try {
    let upstream = await fetch(upstreamURL('/models', `?client_version=${encodeURIComponent(current.clientVersion)}`), { headers: upstreamHeaders(Object.fromEntries(request.headers), lease.accessToken, lease.accountId, 'application/json'), signal: request.signal });
    if (upstream.status === 401) {
      lease.accessToken = await lease.refresh();
      upstream = await fetch(upstreamURL('/models', `?client_version=${encodeURIComponent(current.clientVersion)}`), { headers: upstreamHeaders(Object.fromEntries(request.headers), lease.accessToken, lease.accountId, 'application/json'), signal: request.signal });
    }
    if (!upstream.ok) return new Response(upstream.body, { status: 502, headers: copyResponseHeaders(upstream) });
    const payload = await upstream.json() as { models?: unknown; data?: unknown };
    const values = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
    const data = values.flatMap((value) => {
      if (typeof value === 'string' && value.trim()) return [{ id: value.trim(), object: 'model', owned_by: 'openai' }];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const id = [record.id, record.slug, record.name].find((item): item is string => typeof item === 'string' && Boolean(item.trim()))?.trim();
      return id ? [{ id, object: 'model', owned_by: 'openai' }] : [];
    });
    return json({ object: 'list', data: [...new Map(data.map((model) => [model.id, model])).values()] });
  } catch { return json({ error: { message: 'Codex model discovery failed.', type: 'upstream_error' } }, 502); }
  finally { lease.release(); }
}
function codexImageGenerationBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const source = body as Record<string, unknown>;
  const forwarded: Record<string, unknown> = {};
  for (const field of ['prompt', 'model', 'n', 'background', 'quality', 'size'] as const) {
    if (field in source) forwarded[field] = source[field];
  }
  if (typeof forwarded.model === 'string') {
    forwarded.model = forwarded.model.split('/').slice(1).join('/') || forwarded.model;
  }
  return forwarded;
}

async function imageGenerations(request: Request, requestHeaders: Record<string, string>, body: unknown): Promise<Response> {
  const forwardedBody = codexImageGenerationBody(body);
  let lease;
  try { lease = await acquireCodexAccount(); } catch { return unavailable(); }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = upstreamHeaders(requestHeaders, lease.accessToken, lease.accountId, 'application/json');
      headers.set('content-type', 'application/json');
      headers.set('x-codex-image-turn-id', randomUUID());
      headers.delete('openai-beta');
      const upstream = await fetch(upstreamURL('/images/generations'), {
        method: 'POST',
        headers,
        body: JSON.stringify(forwardedBody),
        signal: request.signal,
      });
      if (upstream.status !== 401 || attempt === 1) return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
      lease.accessToken = await lease.refresh();
    }
    return unavailable();
  } catch {
    return json({ error: { message: 'Codex image generation request failed.', type: 'upstream_error' } }, 502);
  } finally { lease.release(); }
}

async function responses(request: Request, requestHeaders: Record<string, string>, body: unknown, compact: boolean): Promise<Response> {
  const forwardedBody = body && typeof body === 'object' && !Array.isArray(body)
    ? (() => { const value: Record<string, unknown> = { ...(body as Record<string, unknown>), store: false, ...(typeof (body as Record<string, unknown>).model === 'string' ? { model: String((body as Record<string, unknown>).model).split('/').slice(1).join('/') || (body as Record<string, unknown>).model } : {}) }; delete value.max_output_tokens; return value; })()
    : body;
  let lease;
  try { lease = await acquireCodexAccount(); } catch { return unavailable(); }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = upstreamHeaders(requestHeaders, lease.accessToken, lease.accountId, compact ? 'application/json' : 'text/event-stream');
      headers.set('content-type', requestHeaders['content-type'] || 'application/json');
      const upstream = await fetch(upstreamURL(compact ? '/responses/compact' : '/responses'), { method: 'POST', headers, body: forwardedBody === undefined ? undefined : JSON.stringify(forwardedBody), signal: request.signal });
      if (upstream.status !== 401 || attempt === 1) return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
      lease.accessToken = await lease.refresh();
    }
    return unavailable();
  } catch { return json({ error: { message: 'Codex upstream request failed.', type: 'upstream_error' } }, 502); }
  finally { lease.release(); }
}
export function codexRequestHandler({ c, requestURL, requestHeaders, requestBody }: { c: Context; requestURL: string; requestHeaders: Record<string, string>; requestBody: unknown }): Promise<Response> {
  const request = c.req.raw;
  const pathname = new URL(requestURL).pathname;
  if (pathname.endsWith('/models')) return codexModels(request);
  if (pathname.endsWith('/images/generations')) return imageGenerations(request, requestHeaders, requestBody);
  if (pathname.endsWith('/responses/compact')) return responses(request, requestHeaders, requestBody, true);
  return responses(request, requestHeaders, requestBody, false);
}
