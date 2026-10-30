import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway, type GatewayAgentMessage, type ModelProviderConfig } from './index';

// A final answer-only step keeps the tool definitions the history refers to and forbids new
// calls. The request bodies are captured at fetch, exactly as the provider receives them.
const history: GatewayAgentMessage[] = [
  { role: 'user', content: 'Check the Codex hooks.' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'run_host_command', input: { command: 'ls ~/.codex' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'run_host_command', output: { type: 'text', value: 'config.toml' } }] },
  { role: 'user', content: 'The tool budget for this turn is exhausted.' },
];
const tool = { name: 'run_host_command', description: 'Run a command.', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } };

// Only the outgoing request matters here; the empty stream ends the step without text.
function captureRequests() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return bodies;
}

async function finalStep(provider: ModelProviderConfig) {
  return createModelGateway().generateAgentStep({
    candidates: [{ provider, model: 'model' }],
    systemPrompt: 'You are Chat.',
    messages: history,
    skillScripts: [],
    builtinTools: [tool],
    toolsDisabled: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateAgentStep with toolsDisabled', () => {
  it('sends tool_choice none to a Responses provider while keeping the tool definitions', async () => {
    const bodies = captureRequests();
    await finalStep({ id: 'p', adapter: 'openai', operation: 'responses', apiKey: 'key' }).catch(() => undefined);
    expect(bodies[0]?.tool_choice).toBe('none');
    expect((bodies[0]?.tools as unknown[]).length).toBe(1);
  });

  it('keeps Anthropic tool definitions because the Messages API needs them for tool_use history', async () => {
    const bodies = captureRequests();
    await finalStep({ id: 'p', adapter: 'anthropic', operation: 'messages', apiKey: 'key' }).catch(() => undefined);
    expect((bodies[0]?.tools as unknown[]).length).toBe(1);
    expect((bodies[0]?.tool_choice as { type?: string } | undefined)?.type).not.toBe('none');
  });
});
