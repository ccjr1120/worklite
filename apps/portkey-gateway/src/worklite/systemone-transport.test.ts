import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import app from '../index';
import { createProvider, requestLog } from './provider-registry';
import { SYSTEM_ONE_TEST_INPUT } from './systemone-transport';

const TEST_MODEL = 'jev-test';
const TEST_PROVIDER_NAME = 'typesafe-systemone-test';
const originalDatabasePath = process.env.PORTKEY_GATEWAY_DB_PATH;
const testDirectory = mkdtempSync(join(tmpdir(), 'worklite-systemone-'));
const testDatabasePath = join(testDirectory, 'gateway.db');
const fetchMock = jest.spyOn(globalThis, 'fetch');

let providerId = '';

function upstreamResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function runProviderTest(): Promise<Response> {
  return app.request(`/worklite/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: TEST_MODEL }),
  });
}

describe('typesafe/systemone provider connection test', () => {
  beforeAll(async () => {
    process.env.PORTKEY_GATEWAY_DB_PATH = testDatabasePath;
    const provider = await createProvider({
      name: TEST_PROVIDER_NAME,
      baseURL: 'https://typesafe.example/tenant/v1/',
      protocol: 'typesafe/systemone',
      apiKey: 'test-key',
      models: [TEST_MODEL],
      headers: { 'x-tenant-id': 'tenant-a' },
    });
    providerId = provider.id;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    fetchMock.mockRestore();
    if (originalDatabasePath === undefined) delete process.env.PORTKEY_GATEWAY_DB_PATH;
    else process.env.PORTKEY_GATEWAY_DB_PATH = originalDatabasePath;
    rmSync(testDirectory, { recursive: true, force: true });
  });

  it('sends the typed question through the Test button path and returns its answer', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse({
      model: TEST_MODEL,
      answers: { connection: { type: 'noul', noul: 0.82 } },
      usage: { input_tokens: 4, output_tokens: 1 },
    }));

    const response = await runProviderTest();
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      connection: 'connected',
      protocol: 'typesafe/systemone',
      model: TEST_MODEL,
      input: SYSTEM_ONE_TEST_INPUT,
      output: {
        answers: { connection: { type: 'noul', noul: 0.82 } },
        usage: { input_tokens: 4, output_tokens: 1 },
      },
      traceId: expect.any(String),
    }));

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(target)).toBe('https://typesafe.example/tenant/v1/systemone');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('x-tenant-id')).toBe('tenant-a');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: TEST_MODEL,
      state: { message: 'WorkLite provider connection test' },
      questions: { connection: { type: 'noul', instructions: SYSTEM_ONE_TEST_INPUT.questions.connection.instructions } },
    });
  });

  it('returns the upstream failure and exposes its request-log id', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse({ error: 'Invalid API key' }, 401));

    const response = await runProviderTest();
    const payload = await response.json() as { message?: string; requestLogId?: string; testInput?: unknown };

    expect(response.status).toBe(401);
    expect(payload).toEqual({
      message: 'TypeSafe provider request failed (401): Invalid API key',
      requestLogId: expect.stringMatching(/^glog_/),
      protocol: 'typesafe/systemone',
      testInput: SYSTEM_ONE_TEST_INPUT,
    });

    const log = payload.requestLogId ? requestLog(payload.requestLogId) : null;
    expect(log).toEqual(expect.objectContaining({
      provider: TEST_PROVIDER_NAME,
      model: TEST_MODEL,
      endpoint: '/v1/systemone',
      status: 401,
      source: 'provider_test',
      response: { kind: 'json', body: { error: 'Invalid API key' } },
    }));
  });

  it('rejects a successful HTTP response without a typed answer', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse({
      model: TEST_MODEL,
      answers: { connection: { type: 'choice', choice: 'yes' } },
    }));

    const response = await runProviderTest();
    const payload = await response.json() as { message?: string; requestLogId?: string; testInput?: unknown };

    expect(response.status).toBe(502);
    expect(payload).toEqual({
      message: 'TypeSafe provider returned an invalid System One response.',
      requestLogId: expect.stringMatching(/^glog_/),
      protocol: 'typesafe/systemone',
      testInput: SYSTEM_ONE_TEST_INPUT,
    });

    const log = payload.requestLogId ? requestLog(payload.requestLogId) : null;
    expect(log).toEqual(expect.objectContaining({ status: 200, source: 'provider_test' }));
  });
});
