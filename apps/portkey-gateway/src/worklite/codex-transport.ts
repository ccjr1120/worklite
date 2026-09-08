import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { codexAccountId, getCodexAccessToken } from './codex-auth';

type RateLimitWindow = { usedPercent: number; limitWindowSeconds: number; resetsAt: string };
export type CodexRateLimitSnapshot = { planType: string | null; limits: Array<{ id: string; name: string | null; primary: RateLimitWindow | null; secondary: RateLimitWindow | null }> };

type CodexConfig = {
  accessToken: string;
  accountId?: string;
  upstreamBaseURL: string;
  clientVersion: string;
  userAgent: string;
  originator: string;
  residency: string;
};

function config(): CodexConfig {
  return {
    accessToken: process.env.CODEX_ACCESS_TOKEN?.trim() || '',
    accountId: codexAccountId(),
    upstreamBaseURL: (process.env.CODEX_UPSTREAM_URL?.trim() || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, ''),
    clientVersion: process.env.CODEX_CLIENT_VERSION?.trim() || '26.707.31428',
    userAgent: process.env.CODEX_USER_AGENT?.trim() || 'Codex Desktop/26.707.31428 (win32; x64)',
    originator: process.env.CODEX_ORIGINATOR?.trim() || 'codex_cli_rs',
    residency: process.env.CODEX_RESIDENCY?.trim() || 'us',
  };
}

function unavailable(): Response {
  return json({ error: { message: 'Codex Provider is not configured.', type: 'configuration_error' } }, 503);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function upstreamHeaders(requestHeaders: Record<string, string>, accessToken: string, accept: string, includeBeta = false): Headers {
  const current = config();
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    accept,
    'user-agent': current.userAgent,
    originator: current.originator,
    'x-openai-internal-codex-residency': current.residency,
    'x-client-request-id': requestHeaders['x-client-request-id']?.trim() || `req_${randomUUID()}`,
  });
  if (current.accountId) headers.set('chatgpt-account-id', current.accountId);
  if (includeBeta) headers.set('openai-beta', requestHeaders['openai-beta']?.trim() || 'responses_websockets=2026-02-06');
  for (const name of ['openai-beta', 'x-codex-turn-state']) {
    const value = requestHeaders[name]?.trim();
    if (value) headers.set(name, value);
  }
  return headers;
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of ['content-type', 'cache-control', 'x-request-id', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
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
  if (typeof row.used_percent !== 'number' || typeof row.limit_window_seconds !== 'number' || typeof row.reset_at !== 'number') return null;
  return { usedPercent: row.used_percent, limitWindowSeconds: row.limit_window_seconds, resetsAt: new Date(row.reset_at * 1000).toISOString() };
}

function rateLimit(value: unknown, id: string, name: string | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { id, name, primary: null, secondary: null };
  const row = value as Record<string, unknown>;
  return { id, name, primary: rateLimitWindow(row.primary_window), secondary: rateLimitWindow(row.secondary_window) };
}

export async function codexRateLimits(): Promise<CodexRateLimitSnapshot> {
  let accessToken = await getCodexAccessToken();
  if (!accessToken) throw new Error('Codex Provider is not configured.');
  const accountId = codexAccountId();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = new Headers({ authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': config().userAgent });
    if (accountId) headers.set('chatgpt-account-id', accountId);
    const response = await fetch(usageURL(), { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 && attempt === 0) {
      accessToken = await getCodexAccessToken(true);
      if (!accessToken) break;
      continue;
    }
    if (!response.ok) throw new Error(`Codex rate-limit request failed (${response.status}).`);
    const payload = await response.json() as Record<string, unknown>;
    const limits = [rateLimit(payload.rate_limit, 'codex', null)];
    if (Array.isArray(payload.additional_rate_limits)) {
      payload.additional_rate_limits.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        const row = item as Record<string, unknown>;
        const id = typeof row.metered_limit_name === 'string' ? row.metered_limit_name : typeof row.limit_name === 'string' ? row.limit_name : `additional_${index + 1}`;
        const name = typeof row.limit_name === 'string' ? row.limit_name : typeof row.metered_limit_name === 'string' ? row.metered_limit_name : null;
        limits.push(rateLimit(row.rate_limit, id, name));
      });
    }
    return { planType: typeof payload.plan_type === 'string' ? payload.plan_type : null, limits: limits.filter((limit) => limit.primary || limit.secondary) };
  }
  throw new Error('Codex authentication expired.');
}

export async function codexModels(request: Request): Promise<Response> {
  const current = config();
  let accessToken = await getCodexAccessToken();
  if (!accessToken) return unavailable();
  try {
    let upstream = await fetch(upstreamURL('/models', `?client_version=${encodeURIComponent(current.clientVersion)}`), {
      headers: upstreamHeaders(Object.fromEntries(request.headers), accessToken, 'application/json'),
      signal: request.signal,
    });
    if (upstream.status === 401) {
      accessToken = await getCodexAccessToken(true);
      if (!accessToken) return unavailable();
      upstream = await fetch(upstreamURL('/models', `?client_version=${encodeURIComponent(current.clientVersion)}`), { headers: upstreamHeaders(Object.fromEntries(request.headers), accessToken, 'application/json'), signal: request.signal });
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
  } catch {
    return json({ error: { message: 'Codex model discovery failed.', type: 'upstream_error' } }, 502);
  }
}

async function responses(request: Request, requestHeaders: Record<string, string>, body: unknown, compact: boolean): Promise<Response> {
  const current = config();
  const forwardedBody = body && typeof body === 'object' && !Array.isArray(body)
    ? (() => { const value = { ...(body as Record<string, unknown>), store: false, ...(typeof (body as Record<string, unknown>).model === 'string' ? { model: String((body as Record<string, unknown>).model).split('/').slice(1).join('/') || (body as Record<string, unknown>).model } : {}) }; delete value.max_output_tokens; return value; })()
    : body;
  let accessToken = await getCodexAccessToken();
  if (!accessToken) return unavailable();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = upstreamHeaders(requestHeaders, accessToken, compact ? 'application/json' : 'text/event-stream', true);
      headers.set('content-type', requestHeaders['content-type'] || 'application/json');
      const upstream = await fetch(upstreamURL(compact ? '/responses/compact' : '/responses'), { method: 'POST', headers, body: forwardedBody === undefined ? undefined : JSON.stringify(forwardedBody), signal: request.signal });
      if (upstream.status !== 401 || attempt === 1) return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
      accessToken = await getCodexAccessToken(true);
      if (!accessToken) return unavailable();
    }
    return unavailable();
  } catch {
    return json({ error: { message: 'Codex upstream request failed.', type: 'upstream_error' } }, 502);
  }
}

export function codexRequestHandler({ c, requestURL, requestHeaders, requestBody }: { c: Context; requestURL: string; requestHeaders: Record<string, string>; requestBody: unknown }): Promise<Response> {
  const request = c.req.raw;
  const pathname = new URL(requestURL).pathname;
  if (pathname.endsWith('/models')) return codexModels(request);
  if (pathname.endsWith('/responses/compact')) return responses(request, requestHeaders, requestBody, true);
  return responses(request, requestHeaders, requestBody, false);
}
