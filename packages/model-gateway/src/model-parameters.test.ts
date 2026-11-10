import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelRequestParameters, validateModelParameters, type ModelParameters } from '@worklite/contracts';
import { createModelGateway, type ModelCandidate } from './index';

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return bodies;
}
const parameters: ModelParameters = { reasoningEffort: 'high', serviceTier: 'fast', requestBody: { temperature: 0.2 } };

async function step(candidate: ModelCandidate) {
  await createModelGateway().generateAgentStep({ candidates: [candidate], systemPrompt: 'Help.', messages: [{ role: 'user', content: 'Hello' }], skillScripts: [] }).catch(() => undefined);
}

describe('parameters selected at each model use site', () => {
  it.each(['openai', 'codex'] as const)('sends Responses effort and fast for %s without changing another invocation', async (adapter) => {
    const bodies = capture();
    const provider = { id: 'shared', adapter, operation: 'responses' as const, apiKey: 'key' };
    await step({ provider, model: 'model', modelParameters: parameters });
    const count = bodies.length;
    expect(count).toBeGreaterThan(0);
    expect(bodies[0]).toMatchObject({ model: 'model', reasoning: { effort: 'high' }, service_tier: adapter === 'codex' ? 'priority' : 'fast', temperature: 0.2 });
    if (adapter === 'codex') expect(bodies[0]).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
    await step({ provider, model: 'model' });
    expect(bodies[count]).not.toHaveProperty('service_tier');
    expect(bodies[count]).not.toHaveProperty('reasoning');
    expect(provider).not.toHaveProperty('modelParameters');
  });

  it('uses the Chat Completions field names', async () => {
    const bodies = capture();
    await step({ provider: { id: 'p', adapter: 'openai', operation: 'chat/completions', apiKey: 'key' }, model: 'model', modelParameters: parameters });
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high', service_tier: 'fast', temperature: 0.2 });
    expect(bodies[0]).not.toHaveProperty('reasoning');
  });

  it('sends Anthropic effort, speed and protocol-specific thinking parameters', async () => {
    const bodies = capture();
    await step({ provider: { id: 'p', adapter: 'anthropic', apiKey: 'key' }, model: 'model', modelParameters: { ...parameters, requestBody: { thinking: { type: 'adaptive' }, output_config: { custom: true } } } });
    expect(bodies[0]).toMatchObject({ output_config: { effort: 'high', custom: true }, speed: 'fast', thinking: { type: 'adaptive' } });
    expect(bodies[0]).not.toHaveProperty('service_tier');
  });

  it('also applies parameters to summaries and the managed tool loop', async () => {
    const bodies = capture();
    const candidate: ModelCandidate = { provider: { id: 'p', adapter: 'openai', operation: 'responses', apiKey: 'key' }, model: 'model', modelParameters: parameters };
    const stream = createModelGateway().streamText({ candidates: [candidate], systemPrompt: 'Summarize.', messages: [{ role: 'user', content: 'Conversation' }] });
    await stream.result.catch(() => undefined);
    expect(bodies[0]).toMatchObject({ reasoning: { effort: 'high' }, service_tier: 'fast' });
    const count = bodies.length;
    await createModelGateway().runWorkflowAgent({ candidates: [candidate], systemPrompt: 'Help.', initialUserContent: 'Hello', skillScripts: [], mcpTools: [], maxToolRounds: 0, executeTool: async () => ({ type: 'text', value: '' }) }).catch(() => undefined);
    expect(bodies[count]).toMatchObject({ reasoning: { effort: 'high' }, service_tier: 'fast' });
  });

  it('preserves arbitrary System One parameters and rejects transport overrides', () => {
    expect(modelRequestParameters('typesafe/systemone', { requestBody: { temperature: 0.3, options: { limit: 4 } } })).toEqual({ temperature: 0.3, options: { limit: 4 } });
    expect(() => validateModelParameters({ requestBody: [] })).toThrow('JSON object');
    expect(() => validateModelParameters({ reasoningEffort: 'invalid' })).toThrow('reasoning effort');
    expect(() => validateModelParameters({ requestBody: { model: 'other/model' } })).toThrow('override model');
    expect(() => validateModelParameters({ requestBody: { stream: false } })).toThrow('override stream');
  });
});
