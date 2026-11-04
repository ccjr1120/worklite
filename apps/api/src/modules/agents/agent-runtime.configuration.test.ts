// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { realpath } from 'node:fs/promises';
import { validateAgentRuntime } from './agent-runtime.configuration';

describe('Agent runtime configuration', () => {
  it('keeps existing Agents native when no runtime is selected', async () => {
    await expect(validateAgentRuntime(undefined)).resolves.toEqual({ kind: 'native' });
  });

  it('canonicalizes the working directory and preserves the approval policy', async () => {
    await expect(validateAgentRuntime({ kind: 'codex', projectDirectory: '/tmp', approvalPolicy: 'ask' })).resolves.toEqual({ kind: 'codex', projectDirectory: await realpath('/tmp'), approvalPolicy: 'ask' });
  });

  it('rejects unsupported backends, missing directories and invalid approval policies', async () => {
    for (const value of [null, [], { kind: 'unknown' }, { kind: 'claude' }, { kind: 'codex', projectDirectory: '../project' }, { kind: 'codex', projectDirectory: '/definitely-missing-worklite-directory' }, { kind: 'codex', projectDirectory: '/tmp', approvalPolicy: 'bypass' }]) {
      await expect(validateAgentRuntime(value)).rejects.toThrow();
    }
  });
});
