import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentOutputTruncatedError, createModelGateway } from './index';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// The shape pp-cc/claude-opus-5-5 streamed for the WeChat-article writer on 2026-10-31: the
// thinking spent most of the budget and the JSON article stopped mid-object, while one inner
// array ("highlights") had already closed.
function truncatedArticleStream(): Response {
  const partial = '```json\n{"title":"拆开五款大模型","article":"# 正文\\n\\n- 一条","highlights":["看激活参数","看注意力"],"summary":"这五款模型都靠';
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9851, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partial } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 13274 } },
    { type: 'message_stop' },
  ]);
}

describe('Workflow Agent output budget', () => {
  it('gives Anthropic models a 64K default and names the budget when a JSON reply is cut off', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return truncatedArticleStream();
    }));

    const failure = await createModelGateway().runWorkflowAgent({
      candidates: [{ provider: { id: 'pp-cc', adapter: 'anthropic', apiKey: 'key' }, model: 'claude-opus-5-5' }],
      systemPrompt: 'Write the article as JSON.',
      initialUserContent: '{}',
      jsonOutput: true,
      skillScripts: [],
      mcpTools: [],
      maxToolRounds: 0,
    }).catch((error: unknown) => error);

    expect(bodies[0]?.max_tokens).toBe(64_000);
    expect(failure).toBeInstanceOf(AgentOutputTruncatedError);
    expect((failure as AgentOutputTruncatedError).maxOutputTokens).toBe(64_000);
    expect((failure as Error).message).toContain('finishReason=length');
  }, 30_000);

  it('sends a node-specified output budget', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return truncatedArticleStream();
    }));

    const failure = await createModelGateway().runWorkflowAgent({
      candidates: [{ provider: { id: 'pp-cc', adapter: 'anthropic', apiKey: 'key' }, model: 'claude-opus-5-5' }],
      systemPrompt: 'Write the article as JSON.',
      initialUserContent: '{}',
      jsonOutput: true,
      skillScripts: [],
      mcpTools: [],
      maxToolRounds: 0,
      maxOutputTokens: 96_000,
    }).catch((error: unknown) => error);

    expect(bodies[0]?.max_tokens).toBe(96_000);
    expect((failure as AgentOutputTruncatedError).maxOutputTokens).toBe(96_000);
  }, 30_000);
});
