import { describe, expect, it } from 'vitest';
import { executionFailure, executionFailureSource } from './agent-execution-failure';

describe('executionFailure', () => {
  it('maps missing AI tool results to a recognizable model error', () => {
    const error = new Error('Model messages are invalid');
    error.name = 'AI_MissingToolResultsError';

    expect(executionFailure(error)).toEqual({
      message: 'The Agent conversation was missing a tool result. Retry repairs the recorded tool exchange before contacting the model.',
      code: 'missing_tool_results',
      phase: 'model',
    });
    expect(executionFailureSource(error)).toBe('AI_MissingToolResultsError');
  });

  it.each([
    'Context summary was truncated; original history was retained.',
    'The latest user instruction or system/tool definitions exceed the context budget. Shorten the request or increase WORKLITE_CHAT_CONTEXT_TOKENS.',
    'Context cannot be reduced further without losing current instructions.',
    'Context summary did not shrink enough; original history was retained.',
    'Context remains too large after summarization; original history was retained.',
  ])('surfaces a native-context compaction failure verbatim instead of a generic internal error (%s)', (message) => {
    expect(executionFailure(new Error(message))).toEqual({ message, code: 'invalid_request', phase: 'model' });
  });
});
