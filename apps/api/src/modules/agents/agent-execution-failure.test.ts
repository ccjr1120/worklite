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
});
