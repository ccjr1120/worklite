import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway, type GatewayAgentMessage, type ModelProviderConfig } from './index';

// A reasoning part from an earlier step, as persisted history replays it. Without an explicit
// store:false, the OpenAI Responses converter treats an itemId-bearing reasoning part as a
// server-stored item and encodes it as item_reference, which most Responses-compatible gateways
// (anything other than api.openai.com with a matching conversation/previousResponseId) reject.
const historyWithReasoning: GatewayAgentMessage[] = [
  { role: 'user', content: 'Plan the deploy.' },
  { role: 'assistant', content: [
    { type: 'reasoning', text: 'Thinking it through.', providerOptions: { openai: { itemId: 'rs_123' } } },
    { type: 'text', text: 'Here is the plan.' },
  ] },
  { role: 'user', content: 'Go ahead.' },
];

function captureRequests() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Responses-protocol requests never rely on server-side item storage', () => {
  it.each([
    ['openai', { id: 'p', adapter: 'openai', operation: 'responses', apiKey: 'key' } satisfies ModelProviderConfig],
    ['codex', { id: 'p', adapter: 'codex', apiKey: 'key' } satisfies ModelProviderConfig],
  ])('sets store:false for a %s Responses request so reasoning history never becomes an unresolvable item_reference', async (_label, provider) => {
    const bodies = captureRequests();
    await createModelGateway().generateAgentStep({
      candidates: [{ provider, model: 'model' }],
      systemPrompt: 'You are Chat.',
      messages: historyWithReasoning,
      skillScripts: [],
      builtinTools: [],
    }).catch(() => undefined);
    expect(bodies[0]?.store).toBe(false);
    // The reasoning part is replayed as an inline item (encrypted_content or a direct summary),
    // never a reference the next request would need the provider to resolve server-side.
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('item_reference');
  });
});
