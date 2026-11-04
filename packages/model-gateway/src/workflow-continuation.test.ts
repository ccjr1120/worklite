import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelGateway, type GatewayAgentMessage } from './index';

afterEach(() => vi.unstubAllGlobals());
function response(toolCall: boolean) {
  const events = [
    { type: 'message_start', message: { id: toolCall ? 'msg_tool' : 'msg_final', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: toolCall ? { type: 'tool_use', id: 'call_research', name: 'research', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: toolCall ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: 'Revised article' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe('saved Agent model conversation', () => {
  it('sends saved history, checkpoints a tool before its effect, and preserves its result and final reply', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response(bodies.length === 1);
    }));
    const initial: GatewayAgentMessage[] = [{ role: 'user', content: 'Original article' }, { role: 'assistant', content: [{ type: 'text', text: 'First version' }] }, { role: 'user', content: 'Change the title' }];
    let checkpoint: GatewayAgentMessage[] = [];
    const executeTool = vi.fn(async () => {
      expect(JSON.stringify(checkpoint)).toContain('Outcome unknown');
      return { type: 'text' as const, value: 'Saved research result' };
    });
    const result = await createModelGateway().runWorkflowAgent({
      candidates: [{ provider: { id: 'p', adapter: 'anthropic', apiKey: 'key' }, model: 'claude' }],
      systemPrompt: 'Continue the saved task.', initialUserContent: 'Do not use this instead of history', initialMessages: initial,
      onMessages: (messages) => { checkpoint = messages; }, skillScripts: [], mcpTools: [],
      builtinTools: [{ name: 'research', description: 'Read research', inputSchema: { type: 'object', properties: {} } }],
      maxToolRounds: 2, executeTool,
    });
    expect(result.text).toBe('Revised article');
    expect(JSON.stringify(bodies[0]?.messages)).toContain('First version');
    expect(JSON.stringify(bodies[0]?.messages)).not.toContain('Do not use this');
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(checkpoint)).toContain('Saved research result');
    expect(JSON.stringify(checkpoint)).toContain('Revised article');
    expect(JSON.stringify(checkpoint)).not.toContain('Outcome unknown');
    expect(checkpoint.filter((message) => message.role === 'user')).toEqual(initial.filter((message) => message.role === 'user'));
  });
});
