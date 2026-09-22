import { recordRequestLog, recordRequestStat, type GatewayProvider, type GatewayRequestLogResponse } from './provider-registry';

/**
 * System One is not a text-generation contract: it exchanges a `state` value and
 * typed `questions` for typed `answers`, with no message list and no streaming
 * form. This transport therefore forwards the request body unchanged instead of
 * adapting it to any chat protocol, and attaches only credentials.
 */
const SYSTEMONE_PATH = '/v1/systemone';
const SYSTEMONE_TIMEOUT_MS = 60_000;

function upstreamURL(baseURL: string): URL {
  const target = new URL(baseURL);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Unsupported URL');
  if (target.username || target.password) throw new Error('Unsupported URL');
  target.pathname = `${target.pathname.replace(/\/+$/, '')}${SYSTEMONE_PATH}`;
  target.search = '';
  target.hash = '';
  return target;
}

function tokenValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageTokens(payload: unknown): { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } {
  const usage = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).usage
    : undefined;
  const record = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : undefined;
  const promptTokens = tokenValue(record?.input_tokens);
  const completionTokens = tokenValue(record?.output_tokens);
  const reportedTotal = tokenValue(record?.total_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
  };
}

function correlation(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  return value?.trim() ? value.trim() : null;
}

/**
 * Forwards one System One request and records its own statistics and request log.
 * The shared log middleware reads Portkey handler request options, which a
 * passthrough request never populates, so accounting happens here instead.
 */
export async function systemOnePassthrough(request: Request, provider: GatewayProvider, model: string): Promise<Response> {
  const started = Date.now();
  const requestText = await request.text();
  let requestBody: unknown = null;
  try { requestBody = requestText ? JSON.parse(requestText) : null; } catch { requestBody = requestText || null; }

  const finish = (status: number, capture: GatewayRequestLogResponse, payload?: unknown): void => {
    const { promptTokens, completionTokens, totalTokens } = usageTokens(payload);
    const stat = { provider: provider.name, model, endpoint: SYSTEMONE_PATH, status, durationMs: Date.now() - started, promptTokens, completionTokens, totalTokens };
    try { recordRequestStat(stat); } catch (error) { console.error('Error recording request stat:', error); }
    try {
      recordRequestLog({
        ...stat,
        id: correlation(request, 'x-worklite-log-id'),
        streaming: false,
        source: correlation(request, 'x-worklite-log-source'),
        workflowRunId: correlation(request, 'x-worklite-workflow-run-id'),
        nodeRunId: correlation(request, 'x-worklite-node-run-id'),
        request: requestBody,
        response: capture,
      });
    } catch (error) {
      console.error('Error recording request log:', error);
    }
  };

  let target: URL;
  try {
    target = upstreamURL(provider.baseURL);
  } catch {
    const message = 'Provider Base URL is invalid.';
    finish(400, { kind: 'unavailable', reason: message });
    return Response.json({ error: { message } }, { status: 400 });
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  if (provider.apiKey) headers.set('authorization', `Bearer ${provider.apiKey}`);
  for (const [name, value] of Object.entries(provider.headers ?? {})) headers.set(name, value);

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body: requestText, signal: AbortSignal.timeout(SYSTEMONE_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'The provider did not respond in time.'
      : 'Provider request failed.';
    finish(502, { kind: 'unavailable', reason: message });
    return Response.json({ error: { message } }, { status: 502 });
  }

  const raw = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  let payload: unknown;
  let capture: GatewayRequestLogResponse;
  try {
    payload = JSON.parse(raw);
    capture = { kind: 'json', body: payload };
  } catch {
    payload = undefined;
    capture = { kind: 'text', body: raw };
  }
  finish(upstream.status, capture, payload);
  return new Response(raw, { status: upstream.status, headers: { 'content-type': contentType } });
}

/**
 * Sends the smallest valid typed question so a connection test exercises the real
 * contract. The fixed chat prompt used by other protocols has no representation
 * here.
 */
export async function systemOneTest(provider: GatewayProvider, model: string, requestLogId: string): Promise<{ ok: boolean; status: number; response: string }> {
  const body = JSON.stringify({ model, state: 'ok', questions: { connection: { type: 'noul', instructions: 'Does this message contain text?' } } });
  const headers = new Headers({ 'content-type': 'application/json', 'x-worklite-log-source': 'provider_test', 'x-worklite-log-id': requestLogId });
  const response = await systemOnePassthrough(new Request(`http://127.0.0.1${SYSTEMONE_PATH}`, { method: 'POST', headers, body }), provider, model);
  const raw = await response.text();
  if (!response.ok) return { ok: false, status: response.status, response: '' };
  let answer: unknown;
  try { answer = (JSON.parse(raw) as { answers?: Record<string, { noul?: unknown }> }).answers?.connection?.noul; } catch { answer = undefined; }
  return { ok: true, status: response.status, response: typeof answer === 'number' ? String(answer) : raw };
}

export function isSystemOneProtocol(provider: Pick<GatewayProvider, 'protocol'>): boolean {
  return provider.protocol === 'typesafe/systemone';
}
