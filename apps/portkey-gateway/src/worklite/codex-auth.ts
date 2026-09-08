import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CALLBACK_PORT = 1455;
const SESSION_TTL_MS = 30 * 60 * 1000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

type OAuthSession = { state: string; verifier: string; createdAt: number };
type StoredCredential = {
  refresh_token: string;
  access_token: string | null;
  id_token: string | null;
  expires_at: number | null;
  account_id: string | null;
  email: string | null;
  plan_type: string | null;
};

export type CodexAuthStatus = {
  status: 'connected' | 'disconnected' | 'login_pending' | 'error';
  authMethod: 'oauth' | 'environment' | null;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  expiresAt: string | null;
  authorizationUrl?: string;
  sessionId?: string;
  error?: string;
};

let database: BetterSqlite3.Database | null = null;
const sessions = new Map<string, OAuthSession>();
let lastError: string | null = null;
let refreshPromise: Promise<string> | null = null;
let callbackServer: ReturnType<typeof createServer> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

function databasePath(): string {
  const configured = process.env.PORTKEY_GATEWAY_DB_PATH?.trim();
  return configured ? resolve(process.cwd(), configured) : resolve(process.cwd(), 'data/worklite-gateway.db');
}

function db(): BetterSqlite3.Database {
  if (database) return database;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  database = new BetterSqlite3(path);
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS codex_auth_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      id_token TEXT,
      expires_at INTEGER,
      account_id TEXT,
      email TEXT,
      plan_type TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  return database;
}

function stored(): StoredCredential | null {
  const row = db().prepare('SELECT refresh_token, access_token, id_token, expires_at, account_id, email, plan_type FROM codex_auth_credentials WHERE id = 1').get() as (StoredCredential | undefined);
  if (!row) return null;
  return row;
}

function saveCredential(value: { refreshToken: string; accessToken: string; idToken?: string; expiresIn?: number; accountId?: string; email?: string; planType?: string }): void {
  const expiresAt = typeof value.expiresIn === 'number' && value.expiresIn > 0 ? Date.now() + value.expiresIn * 1000 : null;
  db().prepare(`
    INSERT INTO codex_auth_credentials (id, refresh_token, access_token, id_token, expires_at, account_id, email, plan_type, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token, id_token = excluded.id_token, expires_at = excluded.expires_at, account_id = excluded.account_id, email = excluded.email, plan_type = excluded.plan_type, updated_at = excluded.updated_at
  `).run(value.refreshToken, value.accessToken, value.idToken ?? null, expiresAt, value.accountId ?? null, value.email ?? null, value.planType ?? null, Date.now());
  lastError = null;
}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringClaim(claims: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function tokenMetadata(idToken: string | undefined, accessToken: string): { accountId?: string; email?: string; planType?: string } {
  const claims = decodeClaims(idToken || accessToken);
  const authClaims = claims['https://api.openai.com/auth'];
  const auth = authClaims && typeof authClaims === 'object' && !Array.isArray(authClaims) ? authClaims as Record<string, unknown> : {};
  return {
    accountId: stringClaim(claims, ['account_id', 'chatgpt_account_id']) || stringClaim(auth, ['account_id', 'chatgpt_account_id']),
    email: stringClaim(claims, ['email']),
    planType: stringClaim(claims, ['plan_type', 'chatgpt_plan_type']) || stringClaim(auth, ['plan_type', 'chatgpt_plan_type']),
  };
}

function cleanupSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) if (session.createdAt < cutoff) sessions.delete(id);
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function startCodexLogin(): { authorizationUrl: string; sessionId: string } {
  cleanupSessions();
  const sessionId = randomBytes(16).toString('hex');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  sessions.set(sessionId, { state, verifier, createdAt: Date.now() });
  const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: 'openid profile email offline_access', state, code_challenge: codeChallenge(verifier), code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' });
  return { authorizationUrl: `${AUTHORIZE_URL}?${params.toString()}`, sessionId };
}

async function exchangeCode(code: string, session: OAuthSession): Promise<void> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, redirect_uri: REDIRECT_URI, code_verifier: session.verifier });
  const response = await fetch(TOKEN_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'codex-cli' }, body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Codex authorization exchange failed (${response.status}).`);
  const payload = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  if (!payload.access_token || !payload.refresh_token) throw new Error('Codex authorization did not return both access and refresh tokens.');
  const metadata = tokenMetadata(payload.id_token, payload.access_token);
  saveCredential({ refreshToken: payload.refresh_token, accessToken: payload.access_token, idToken: payload.id_token, expiresIn: payload.expires_in, ...metadata });
}

export async function handleCodexOAuthCallback(code: string, state: string): Promise<string> {
  cleanupSessions();
  const entry = [...sessions.entries()].find(([, value]) => value.state === state);
  if (!entry) return callbackPage('Codex login failed', 'The login session is missing or expired.', false);
  try {
    await exchangeCode(code, entry[1]);
    sessions.delete(entry[0]);
    return callbackPage('Codex login complete', 'You can close this window and return to WorkLite.', true);
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Codex login failed.';
    return callbackPage('Codex login failed', lastError, false);
  }
}

function callbackPage(title: string, message: string, success: boolean): string {
  const color = success ? '#218739' : '#b42318';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;padding:3rem"><h1 style="color:${color}">${title}</h1><p>${message}</p></body></html>`;
}

async function refreshStoredCredential(): Promise<string> {
  const current = stored();
  if (!current?.refresh_token) throw new Error('No persisted Codex refresh token is available.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: current.refresh_token, scope: 'openid profile email offline_access' });
  let lastFailure = 'Codex token refresh failed.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(TOKEN_URL, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'codex-cli' }, body, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        lastFailure = `Codex token refresh failed (${response.status}).`;
        if (response.status < 500 || attempt === 2) throw new Error(lastFailure);
      } else {
        const payload = await response.json() as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
        if (!payload.access_token) throw new Error('Codex token refresh did not return an access token.');
        const metadata = tokenMetadata(payload.id_token, payload.access_token);
        saveCredential({ refreshToken: payload.refresh_token || current.refresh_token, accessToken: payload.access_token, idToken: payload.id_token || current.id_token || undefined, expiresIn: payload.expires_in, accountId: metadata.accountId || current.account_id || undefined, email: metadata.email || current.email || undefined, planType: metadata.planType || current.plan_type || undefined });
        return payload.access_token;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : lastFailure;
      if (attempt === 2 || /failed \(4\d\d\)/.test(lastFailure)) throw new Error(lastFailure);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (attempt + 1)));
  }
  throw new Error(lastFailure);
}

export async function getCodexAccessToken(forceRefresh = false): Promise<string> {
  const current = stored();
  if (current?.access_token && !forceRefresh && (!current.expires_at || current.expires_at - Date.now() > REFRESH_WINDOW_MS)) return current.access_token;
  if (current?.refresh_token) {
    if (!refreshPromise) {
      refreshPromise = refreshStoredCredential().finally(() => { refreshPromise = null; });
    }
    try { return await refreshPromise; } catch (error) { lastError = error instanceof Error ? error.message : 'Codex token refresh failed.'; }
  }
  if (current?.access_token && (!current.expires_at || current.expires_at > Date.now())) return current.access_token;
  return process.env.CODEX_ACCESS_TOKEN?.trim() || '';
}

export async function refreshCodexCredential(): Promise<CodexAuthStatus> {
  const token = await getCodexAccessToken(true);
  if (!token) throw new Error(lastError || 'No Codex credential is available to refresh.');
  return codexAuthStatus();
}

export function logoutCodex(): void {
  db().prepare('DELETE FROM codex_auth_credentials WHERE id = 1').run();
  lastError = null;
}

export function codexAuthStatus(): CodexAuthStatus {
  cleanupSessions();
  const current = stored();
  const envToken = process.env.CODEX_ACCESS_TOKEN?.trim();
  if (current?.access_token || envToken) {
    return { status: 'connected', authMethod: current ? 'oauth' : 'environment', email: current?.email ?? null, accountId: current?.account_id ?? process.env.CODEX_ACCOUNT_ID?.trim() ?? null, planType: current?.plan_type ?? null, expiresAt: current?.expires_at ? new Date(current.expires_at).toISOString() : null, error: lastError ?? undefined };
  }
  if (sessions.size > 0) {
    const [sessionId] = sessions.keys();
    return { status: 'login_pending', authMethod: null, email: null, accountId: null, planType: null, expiresAt: null, sessionId };
  }
  return { status: lastError ? 'error' : 'disconnected', authMethod: null, email: null, accountId: null, planType: null, expiresAt: null, error: lastError ?? undefined };
}

export function codexAccountId(): string | undefined {
  return stored()?.account_id ?? process.env.CODEX_ACCOUNT_ID?.trim() ?? undefined;
}

export function startCodexOAuthCallbackServer(): void {
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { void getCodexAccessToken(); }, 60_000);
    refreshTimer.unref?.();
  }
  if (callbackServer || process.env.CODEX_OAUTH_CALLBACK_ENABLED === 'false') return;
  callbackServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const requestURL = new URL(request.url || '/', `http://127.0.0.1:${CALLBACK_PORT}`);
    if (requestURL.pathname !== new URL(REDIRECT_URI).pathname) {
      response.writeHead(404).end('Not found');
      return;
    }
    const code = requestURL.searchParams.get('code');
    const state = requestURL.searchParams.get('state');
    const html = code && state ? await handleCodexOAuthCallback(code, state) : callbackPage('Codex login failed', 'The callback did not include code and state.', false);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  });
  callbackServer.on('error', (error) => { lastError = `Codex OAuth callback listener failed: ${error.message}`; callbackServer = null; });
  callbackServer.listen(CALLBACK_PORT, '127.0.0.1');
}
