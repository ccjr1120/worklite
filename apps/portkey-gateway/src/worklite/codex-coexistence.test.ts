import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import app from '../index';
import { stopGatewayDatabaseMaintenance } from './provider-registry';

const environment = vi.hoisted(() => {
  const directory = `${process.cwd()}/.tmp-codex-coexistence-${process.pid}-${Date.now()}`;
  const originalPath = process.env.PORTKEY_GATEWAY_DB_PATH;
  const originalToken = process.env.CODEX_ACCESS_TOKEN;
  process.env.PORTKEY_GATEWAY_DB_PATH = `${directory}/gateway.db`;
  delete process.env.CODEX_ACCESS_TOKEN;
  return { directory, originalPath, originalToken };
});
const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
const fetchMock = vi.spyOn(globalThis, 'fetch');
let providerId: string;

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
function request(path: string, body: unknown, method = 'POST') {
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, body, headers: new Headers(init?.headers) });
    if (url.includes('/models')) return json({ models: [{ slug: 'gpt-test' }, { slug: 'gpt-image-2' }] });
    if (url.endsWith('/images/generations')) return json({ data: [{ b64_json: 'test-image' }] });
    if (url.endsWith('/responses/compact')) return json({ output: [{ type: 'compaction', encrypted_content: 'test-context' }] });
    if (url.endsWith('/responses')) return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-codex-test': 'preserved' } });
    throw new Error(`Unexpected upstream: ${url}`);
  });
  const imported = await request('/worklite/codex/accounts/import', { accounts: [{ name: 'Test account', platform: 'openai', type: 'oauth', credentials: { access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), chatgpt_account_id: 'fake-account' } }] });
  expect(imported.status).toBe(200);
  const created = await request('/worklite/providers', { name: 'custom-codex', protocol: 'codex/responses', baseURL: 'https://chatgpt.com/backend-api/codex', models: ['gpt-test', 'gpt-image-2'] });
  expect(created.status).toBe(201);
  providerId = (await created.json() as { id: string }).id;
});
afterEach(() => { requests.length = 0; });
afterAll(() => {
  fetchMock.mockRestore();
  stopGatewayDatabaseMaintenance();
  if (environment.originalPath === undefined) delete process.env.PORTKEY_GATEWAY_DB_PATH;
  else process.env.PORTKEY_GATEWAY_DB_PATH = environment.originalPath;
  if (environment.originalToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
  else process.env.CODEX_ACCESS_TOKEN = environment.originalToken;
  rmSync(environment.directory, { recursive: true, force: true });
});

describe('Codex reverse proxy alongside engine runtimes', () => {
  it('discovers models and retains both the custom Provider and the managed default catalog', async () => {
    const discovery = await request(`/worklite/providers/${providerId}/discover-models`, {});
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ models: ['gpt-test', 'gpt-image-2'] });
    const listed = await app.request('/worklite/providers');
    expect(await listed.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: providerId, protocol: 'codex/responses', status: 'connected' }),
      expect.objectContaining({ name: 'codex', protocol: 'codex/responses', models: ['gpt-test', 'gpt-image-2'] }),
    ]));
  });

  it('runs the Provider test through Codex and applies use-site parameters', async () => {
    const response = await request(`/worklite/providers/${providerId}/test`, { model: 'gpt-test', modelParameters: { reasoningEffort: 'high', serviceTier: 'fast' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: 'connected', protocol: 'codex/responses', response: 'Hello' });
    const upstream = requests.find((item) => item.url.endsWith('/responses'))!;
    expect(upstream.body).toMatchObject({ model: 'gpt-test', store: false, stream: true, reasoning: { effort: 'high' }, service_tier: 'priority' });
    expect(upstream.headers.get('authorization')).toBe('Bearer fake-access-token');
  });

  it('streams public Responses and fixes raw fast tiers at the upstream boundary', async () => {
    const response = await request('/v1/responses', { model: 'custom-codex/gpt-test', input: 'Hello', stream: true, service_tier: 'fast', max_output_tokens: 500 });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('response.completed');
    expect(response.headers.get('x-codex-test')).toBe('preserved');
    const upstream = requests.find((item) => item.url.endsWith('/responses'))!;
    expect(upstream.body).toMatchObject({ model: 'gpt-test', store: false, service_tier: 'priority' });
    expect(upstream.body).not.toHaveProperty('max_output_tokens');
  });

  it('forwards Codex image generation with only supported fields', async () => {
    const response = await request('/v1/images/generations', { model: 'custom-codex/gpt-image-2', prompt: 'A test', size: '1024x1024', unsupported: 'drop' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ b64_json: 'test-image' }] });
    expect(requests.find((item) => item.url.endsWith('/images/generations'))?.body).toEqual({ model: 'gpt-image-2', prompt: 'A test', size: '1024x1024' });
  });

  it('updates and deletes a custom Codex Provider through the regular CRUD routes', async () => {
    const updated = await request(`/worklite/providers/${providerId}`, { name: 'renamed-codex' }, 'PATCH');
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ protocol: 'codex/responses', name: 'renamed-codex' });
    expect((await app.request(`/worklite/providers/${providerId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/worklite/providers/${providerId}`)).status).toBe(404);
  });
});
