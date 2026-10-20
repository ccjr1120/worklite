import { describe, expect, it } from 'vitest';
import { formatError } from './agent-team-runtime.service';

// formatError() feeds both the Run failure reason persisted by handleGraphFailure and the
// group transcript system message shown to the user. Before this fix, a LangGraph-internal
// EmptyInputError ("Received no input writes for \"__start__\"") reached the user verbatim,
// which reads as an opaque engine crash rather than an actionable reason.
describe('formatError', () => {
  it('translates LangGraph EmptyInputError into a readable orchestration-start failure', () => {
    const error = new Error('Received no input writes for "__start__"');
    error.name = 'EmptyInputError';

    const message = formatError(error);

    expect(message).toContain('could not start');
    expect(message).toContain('"__start__"');
    expect(message).not.toBe('Received no input writes for "__start__"');
  });

  it('keeps the original message for an ordinary error', () => {
    expect(formatError(new Error('The Developer task failed to apply changes.')))
      .toBe('The Developer task failed to apply changes.');
  });

  it('falls back to a generic message for a non-Error value', () => {
    expect(formatError('boom')).toBe('The Agent Team task failed.');
  });
});
