import { vi } from 'vitest';
import { rmSync } from 'node:fs';

import app from '../index';
import { createProvider, getProvider, stopGatewayDatabaseMaintenance } from './provider-registry';

const testEnvironment = vi.hoisted(() => {
  const directory = `${process.cwd()}/.tmp-provider-models-${process.pid}-${Date.now()}`;
  const originalDatabasePath = process.env.PORTKEY_GATEWAY_DB_PATH;
  // The application opens the registry during import, before beforeAll runs.
  process.env.PORTKEY_GATEWAY_DB_PATH = `${directory}/gateway.db`;
  return { directory, originalDatabasePath };
});
const fetchMock = vi.spyOn(globalThis, 'fetch');
const apiKey = 'provider-model-test-key';

let providerId = '';

describe('saved Provider model operations', () => {
  beforeAll(async () => {
    const provider = await createProvider({
      name: 'provider-model-test',
      baseURL: 'https://models.example/v1/',
      protocol: 'openai/chat',
      apiKey,
      models: ['existing-model'],
      headers: { 'x-tenant-id': 'tenant-a' },
    });
    providerId = provider.id;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    fetchMock.mockRestore();
    stopGatewayDatabaseMaintenance();
    if (testEnvironment.originalDatabasePath === undefined) delete process.env.PORTKEY_GATEWAY_DB_PATH;
    else process.env.PORTKEY_GATEWAY_DB_PATH = testEnvironment.originalDatabasePath;
    rmSync(testEnvironment.directory, { recursive: true, force: true });
  });

  it('discovers upstream model ids with stored credentials and returns ids only', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.request('/worklite/providers/' + encodeURIComponent(providerId) + '/discover-models', { method: 'POST' });
    const payload = await response.json() as { models?: string[]; apiKey?: string; encryptedKey?: string };
    const [upstreamUrl, upstreamOptions] = fetchMock.mock.calls[0] as [string | URL | Request, RequestInit | undefined];
    const upstreamHeaders = new Headers(upstreamOptions?.headers);

    expect(response.status).toBe(200);
    expect(payload).toEqual({ models: ['model-a', 'model-b'] });
    expect(JSON.stringify(payload)).not.toContain(apiKey);
    expect(payload.apiKey).toBeUndefined();
    expect(payload.encryptedKey).toBeUndefined();
    expect(String(upstreamUrl)).toBe('https://models.example/v1/models');
    expect(upstreamHeaders.get('authorization')).toBe('Bearer ' + apiKey);
    expect(upstreamHeaders.get('x-tenant-id')).toBe('tenant-a');
  });

  it('does not relay credentials echoed by an upstream discovery error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'rejected credential: ' + apiKey }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.request('/worklite/providers/' + encodeURIComponent(providerId) + '/discover-models', { method: 'POST' });
    const result = await response.text();

    expect(response.status).toBe(502);
    expect(result).toContain('HTTP 401');
    expect(result).not.toContain(apiKey);
  });

  it('adds model ids without replacing existing entries or returning credentials', async () => {
    const response = await app.request('/worklite/providers/' + encodeURIComponent(providerId) + '/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addModels: ['added-model', 'existing-model', 'added-model'] }),
    });
    const payload = await response.json() as { providerId?: string; models?: string[]; apiKey?: string; encryptedKey?: string };
    const provider = await getProvider(providerId);

    expect(response.status).toBe(200);
    expect(payload).toEqual({ providerId, models: ['existing-model', 'added-model'] });
    expect(JSON.stringify(payload)).not.toContain(apiKey);
    expect(payload.apiKey).toBeUndefined();
    expect(payload.encryptedKey).toBeUndefined();
    expect(provider?.models).toEqual(['existing-model', 'added-model']);
    expect(provider?.apiKey).toBe(apiKey);
  });

  it('rejects unexpected model update fields without returning them', async () => {
    const response = await app.request('/worklite/providers/' + encodeURIComponent(providerId) + '/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addModels: ['another-model'], apiKey }),
    });
    const result = await response.text();

    expect(response.status).toBe(400);
    expect(result).not.toContain(apiKey);
  });
});
