// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import app from '../index';
import { createProvider, stopGatewayDatabaseMaintenance } from './provider-registry';
import { transformToProviderRequest } from '../services/transformToProviderRequest';
import { modelRequestParameters } from '@worklite/contracts';

// Verify the final Portkey mapping, after parameters leave the platform's SDK.
describe('native protocol model parameters', () => {
  it.each([
    ['openai', 'chatComplete', 'openai/chat'],
    ['openai', 'createModelResponse', 'openai/responses'],
    ['anthropic', 'messages', 'anthropic/messages'],
  ] as const)('preserves effort, fast and extensions for %s/%s', (provider, operation, protocol) => {
    const parameters = modelRequestParameters(protocol, { reasoningEffort: 'high', serviceTier: 'fast', requestBody: { future_parameter: { enabled: true } } });
    const body = { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], input: 'Hello', max_tokens: 1024, ...parameters };
    const outgoing = transformToProviderRequest(provider, body as never, body as never, operation, {}, {} as never);
    expect(outgoing).toMatchObject(parameters);
  });
});

const testEnvironment = vi.hoisted(() => {
  const directory = `${process.cwd()}/.tmp-model-parameters-${process.pid}-${Date.now()}`;
  const originalDatabasePath = process.env.PORTKEY_GATEWAY_DB_PATH;
  // The app opens its registry during module evaluation, before beforeAll runs.
  process.env.PORTKEY_GATEWAY_DB_PATH = `${directory}/gateway.db`;
  return { directory, originalDatabasePath };
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  stopGatewayDatabaseMaintenance();
  if (testEnvironment.originalDatabasePath === undefined) delete process.env.PORTKEY_GATEWAY_DB_PATH;
  else process.env.PORTKEY_GATEWAY_DB_PATH = testEnvironment.originalDatabasePath;
  rmSync(testEnvironment.directory, { recursive: true, force: true });
});

describe('Provider test use-site parameters', () => {
  it.each(['openai/chat', 'openai/responses', 'anthropic/messages', 'typesafe/systemone'] as const)('forwards selected parameters to the %s upstream', async (protocol) => {
    const provider = await createProvider({ name: `params-${protocol.split('/')[0]}-${protocol.split('/')[1]}`, protocol, apiKey: 'test-key', baseURL: 'https://parameters.example/v1', models: ['test-model'] });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 'r1', object: 'response', model: 'test-model', output: [], content: [{ type: 'text', text: 'Hi' }], choices: [{ message: { content: 'Hi' } }], answers: { connection: { type: 'noul', noul: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const parameters = protocol === 'typesafe/systemone' ? { requestBody: { temperature: 0.2 } } : { reasoningEffort: 'high' as const, serviceTier: 'fast' as const };
    const response = await app.request(`/worklite/providers/${provider.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', modelParameters: parameters }) });
    expect(response.status).toBe(200);
    expect(bodies[0]).toMatchObject(modelRequestParameters(protocol, parameters));
    expect(bodies[0]?.model).toBe('test-model');
    expect(provider).not.toHaveProperty('modelParameters');
  });
});
