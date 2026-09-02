import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

type Config = {
  host: string;
  port: number;
  proxyApiKey: string;
  accessToken: string;
  accountId: string | undefined;
  upstreamBaseURL: string;
  clientVersion: string;
  userAgent: string;
  originator: string;
  residency: string;
};

const config = loadConfig();

function loadConfig(): Config {
  return {
    host: process.env.CODEX_PROXY_HOST?.trim() || '127.0.0.1',
    port: parsePort(process.env.CODEX_PROXY_PORT, 4548),
    proxyApiKey: process.env.CODEX_PROXY_API_KEY?.trim() || '',
    accessToken: process.env.CODEX_ACCESS_TOKEN?.trim() || '',
    accountId: process.env.CODEX_ACCOUNT_ID?.trim() || undefined,
    upstreamBaseURL: (process.env.CODEX_UPSTREAM_URL?.trim() || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, ''),
    clientVersion: process.env.CODEX_CLIENT_VERSION?.trim() || '26.707.31428',
    userAgent: process.env.CODEX_USER_AGENT?.trim() || 'Codex Desktop/26.707.31428 (win32; x64)',
    originator: process.env.CODEX_ORIGINATOR?.trim() || 'codex_cli_rs',
    residency: process.env.CODEX_RESIDENCY?.trim() || 'us',
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

function requestPath(request: IncomingMessage): { pathname: string; search: string } {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
  return { pathname: parsed.pathname, search: parsed.search };
}

function writeJSON(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

function unauthorized(response: ServerResponse): void {
  writeJSON(response, 401, { error: { message: 'Invalid API key.', type: 'invalid_api_key' } });
}

function configured(): boolean {
  return Boolean(config.proxyApiKey && config.accessToken);
}

function validAPIKey(request: IncomingMessage): boolean {
  if (!config.proxyApiKey) return false;
  const authorization = request.headers.authorization;
  const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'].trim() : '';
  const expected = Buffer.from(config.proxyApiKey);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function upstreamURL(pathname: string, search = ''): string {
  return `${config.upstreamBaseURL}${pathname}${search}`;
}

function upstreamHeaders(request: IncomingMessage, accept: string, includeBeta = false): Headers {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${config.accessToken}`);
  headers.set('accept', accept);
  headers.set('user-agent', config.userAgent);
  headers.set('originator', config.originator);
  headers.set('x-openai-internal-codex-residency', config.residency);
  headers.set('x-client-request-id', request.headers['x-client-request-id']?.toString() || `req_${randomUUID()}`);
  if (config.accountId) headers.set('chatgpt-account-id', config.accountId);
  if (includeBeta) headers.set('openai-beta', request.headers['openai-beta']?.toString() || 'responses_websockets=2026-02-06');

  for (const name of ['openai-beta', 'x-codex-turn-state']) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.trim()) headers.set(name, value);
  }
  return headers;
}

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  for (const name of ['content-type', 'cache-control', 'x-request-id', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
}

async function proxyStream(request: IncomingMessage, response: ServerResponse, pathname: string, body: Buffer, search = ''): Promise<void> {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  try {
    const headers = upstreamHeaders(request, pathname.endsWith('/compact') ? 'application/json' : 'text/event-stream', true);
    if (body.length > 0) headers.set('content-type', request.headers['content-type'] || 'application/json');
    const upstream = await fetch(upstreamURL(pathname, search), {
      method: request.method,
      headers,
      body: body.length > 0 ? body.toString('utf8') : undefined,
      signal: controller.signal,
    });
    copyResponseHeaders(upstream, response);
    response.statusCode = upstream.status;
    if (!upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>).pipe(response);
  } catch {
    if (!response.headersSent) writeJSON(response, 502, { error: { message: 'Codex upstream request failed.', type: 'upstream_error' } });
    else response.end();
  }
}

async function modelList(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  try {
    const upstream = await fetch(upstreamURL('/models', `?client_version=${encodeURIComponent(config.clientVersion)}`), {
      headers: upstreamHeaders(request, 'application/json'),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      writeJSON(response, 502, { error: { message: 'Codex model discovery failed.', type: 'upstream_error' } });
      return;
    }
    const payload = await upstream.json() as { models?: unknown; data?: unknown };
    const values = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
    const data = values.flatMap((value) => {
      if (typeof value === 'string' && value.trim()) return [{ id: value.trim(), object: 'model', owned_by: 'openai' }];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const id = [record.id, record.slug, record.name].find((item): item is string => Boolean(typeof item === 'string' && item.trim()))?.trim();
      return id ? [{ id, object: 'model', owned_by: 'openai' }] : [];
    });
    const unique = [...new Map(data.map((model) => [model.id, model])).values()];
    writeJSON(response, 200, { object: 'list', data: unique });
  } catch {
    if (!response.headersSent) writeJSON(response, 502, { error: { message: 'Codex model discovery failed.', type: 'upstream_error' } });
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { pathname, search } = requestPath(request);
  if (request.method === 'GET' && pathname === '/health') {
    writeJSON(response, 200, { status: 'ok', configured: configured() });
    return;
  }
  if (!validAPIKey(request)) {
    unauthorized(response);
    return;
  }
  if (!configured()) {
    writeJSON(response, 503, { error: { message: 'Codex Proxy is not configured.', type: 'configuration_error' } });
    return;
  }
  if (request.method === 'GET' && pathname === '/v1/models') {
    await modelList(request, response);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/responses') {
    await proxyStream(request, response, '/responses', await readBody(request), search);
    return;
  }
  if (request.method === 'POST' && pathname === '/v1/responses/compact') {
    await proxyStream(request, response, '/responses/compact', await readBody(request), search);
    return;
  }
  writeJSON(response, 404, { error: { message: 'Route not found.', type: 'invalid_request_error' } });
}

const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(config.port, config.host, () => {
  console.log(`Codex Proxy listening on http://${config.host}:${config.port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
