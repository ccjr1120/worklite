import { describe, expect, it } from 'vitest';
import { insertAgentToolResults, normalizeAgentModelMessages, type StoredAgentToolResult } from './agent-model-messages';
import type { StoredAgentModelMessage } from './schema';

const toolResult = (toolCallId: string, value = 'result'): StoredAgentToolResult => ({
  type: 'tool-result',
  toolCallId,
  toolName: 'inspect_workspace',
  output: { type: 'text', value },
});

describe('agent model message helpers', () => {
  it('inserts results directly after their originating assistant message', () => {
    const messages: StoredAgentModelMessage[] = [
      { role: 'user', content: 'request' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect_workspace', input: {} }] },
      { role: 'user', content: 'follow-up' },
    ];

    expect(insertAgentToolResults(messages, [toolResult('call-1')])).toEqual([
      messages[0],
      messages[1],
      { role: 'tool', content: [toolResult('call-1')] },
      messages[2],
    ]);
  });

  it('groups a new result with an adjacent result for the same assistant message', () => {
    const first = toolResult('call-1', 'first');
    const second = toolResult('call-2', 'second');
    const messages: StoredAgentModelMessage[] = [
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect_workspace', input: {} },
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'inspect_workspace', input: {} },
      ] },
      { role: 'tool', content: [first] },
    ];

    expect(insertAgentToolResults(messages, [second])).toEqual([
      messages[0],
      { role: 'tool', content: [first, second] },
    ]);
  });

  it('moves a late tool result before the intervening user message', () => {
    const late = toolResult('call-1');
    const messages: StoredAgentModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect_workspace', input: {} }] },
      { role: 'user', content: 'follow-up' },
      { role: 'tool', content: [late] },
    ];

    expect(normalizeAgentModelMessages(messages)).toEqual([
      messages[0],
      { role: 'tool', content: [late] },
      messages[1],
    ]);
  });

  it('synthesizes an error result for a missing tool call result', () => {
    const messages: StoredAgentModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect_workspace', input: {} }] },
    ];
    const normalized = normalizeAgentModelMessages(messages);

    expect(normalized).toEqual([
      messages[0],
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'inspect_workspace',
          output: {
            type: 'error-text',
            value: 'The previous tool attempt did not complete and its result was missing from stored history.',
          },
        }],
      },
    ]);
  });
});
