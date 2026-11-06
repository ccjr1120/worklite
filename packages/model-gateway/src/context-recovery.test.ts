import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway, ModelGatewayError, type GatewayAgentMessage, type WorkflowAgentToolCall } from './index';

const candidate = { provider: { id: 'p', adapter: 'anthropic' as const, apiKey: 'key' }, model: 'claude' };
const initial: GatewayAgentMessage[] = [{ role: 'user', content: 'Original goal' }, { role: 'assistant', content: [{ type: 'text', text: 'Old evidence' }] }, { role: 'user', content: 'Latest correction' }];
const overflow = () => new Response(JSON.stringify({ error: { message: 'anthropic error: prompt is too long: 1000001 tokens > 1000000 maximum' } }), { status: 400, headers: { 'content-type': 'application/json' } });
function message(text = 'Done', toolId?: string) {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: toolId ? [{ type: 'tool_use', id: toolId, name: 'work', input: {} }] : [{ type: 'text', text }], stop_reason: toolId ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } };
}
function stream(toolId?: string) {
  const msg = message('Done', toolId);
  const events = [
    { type: 'message_start', message: { ...msg, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: toolId ? { type: 'tool_use', id: toolId, name: 'work', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: toolId ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'Done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.unstubAllGlobals());

describe('context recovery', () => {
  it('archives and checkpoints an overflowing step, keeping the latest user requirement', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (!body.stream) return Response.json(message('Goal; completed evidence; unfinished correction; inspect uncertain writes.'));
      return bodies.length === 1 ? overflow() : stream();
    }));
    const archive = vi.fn(async () => 'acr_history');
    const onMessages = vi.fn();
    const result = await createModelGateway().generateAgentStep({ candidates: [candidate], systemPrompt: 'Work', messages: initial, skillScripts: [], onContextCheckpoint: archive, onMessages });
    expect(result.text).toBe('Done');
    expect(archive).toHaveBeenCalledWith({ messages: initial, summary: expect.stringContaining('unfinished correction') });
    expect(onMessages).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(bodies.at(-1))).toContain('acr_history');
    expect(JSON.stringify(bodies.at(-1))).toContain('Latest correction');
    expect(JSON.stringify(bodies.at(-1))).not.toContain('Old evidence');
  });

  it('recovers inside a workflow without replaying prior tool effects or reintroducing old history', async () => {
    let modelCalls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (!body.stream) return Response.json(message('work call_before completed. Continue latest correction; do not replay it.'));
      modelCalls += 1;
      if (modelCalls === 1) return stream('call_before');
      if (modelCalls === 2) return overflow();
      if (modelCalls === 3) return stream('call_after');
      return stream();
    }));
    const executeTool = vi.fn(async (_call: WorkflowAgentToolCall) => ({ type: 'text' as const, value: 'effect recorded' }));
    let saved: GatewayAgentMessage[] = [];
    const result = await createModelGateway().runWorkflowAgent({
      candidates: [candidate], systemPrompt: 'Work', initialMessages: initial, initialUserContent: '',
      skillScripts: [], mcpTools: [], builtinTools: [{ name: 'work', description: 'Work', inputSchema: { type: 'object', properties: {} } }],
      maxToolRounds: 5, executeTool, onContextCheckpoint: async () => 'acr_history', onMessages: (messages) => { saved = messages; },
    });
    expect(result.text).toBe('Done');
    expect(executeTool.mock.calls.map(([call]) => call.toolCallId)).toEqual(['call_before', 'call_after']);
    expect(JSON.stringify(saved)).toContain('acr_history');
    expect(JSON.stringify(saved)).toContain('effect recorded');
    expect(JSON.stringify(saved)).not.toContain('Old evidence');
    expect(JSON.stringify(bodies.at(-1))).not.toContain('Old evidence');
  });

  it('does not compact or retry a stream after text or tool input has started', async () => {
    let calls = 0;
    const archive = vi.fn(async () => 'acr_unused');
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      const events = [
        { type: 'message_start', message: { ...message(), content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial response' } },
        { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }));
    await expect(createModelGateway().runWorkflowAgent({ candidates: [candidate], systemPrompt: 'Work', initialMessages: initial, initialUserContent: '', skillScripts: [], mcpTools: [], maxToolRounds: 2, executeTool: async () => ({ type: 'text', value: 'unused' }), onContextCheckpoint: archive })).rejects.toBeInstanceOf(Error);
    expect(archive).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });

  it('does not replace history or retry effects if archive persistence fails', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_: unknown, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      return body.stream ? overflow() : Response.json(message('Summary'));
    }));
    const onMessages = vi.fn();
    await expect(createModelGateway().generateAgentStep({ candidates: [candidate], systemPrompt: 'Work', messages: initial, skillScripts: [], onContextCheckpoint: async () => { throw new Error('Disk failed'); }, onMessages })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(onMessages).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  });

  it('classifies the actual Anthropic overflow as a request problem when recovery is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => overflow()));
    const result = await createModelGateway().generateAgentStep({ candidates: [candidate], systemPrompt: 'Work', messages: initial, skillScripts: [] }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(ModelGatewayError);
    expect(result).toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
