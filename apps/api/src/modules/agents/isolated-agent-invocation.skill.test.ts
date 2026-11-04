import { describe, expect, it, vi } from 'vitest';

// Capture the exact request the shared invocation hands to the Gateway so the
// test asserts real prompt/tool composition instead of a reimplementation.
const gateway = vi.hoisted(() => ({ runWorkflowAgent: vi.fn() }));

vi.mock('@worklite/model-gateway', () => ({
  createModelGateway: () => ({ runWorkflowAgent: gateway.runWorkflowAgent }),
}));

import { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';

const dinoSkill = {
  id: 'sk_dino',
  name: 'dino-cli',
  instructions: '# Dino CLI\nUse `dino-cli account current` to inspect the active account.',
  files: [
    { path: 'SKILL.md', content: '# Dino CLI\nUse `dino-cli account current` to inspect the active account.' },
    { path: 'references/commands.md', content: 'account login -e <email> records a web account.' },
    { path: 'scripts/check.sh', content: '#!/bin/sh\ndino-cli account current\n' },
  ],
};

function service() {
  const resources = {
    publicModelRuntime: async () => ({ provider: { id: 'provider' }, model: 'model' }),
    publicModelCandidates: async () => [{ provider: { id: 'provider' }, model: 'model' }],
  };
  const mcpRuntime = { discover: async () => [] };
  const builtinTools = {
    toolDefinitions: (names?: readonly string[]) => names === undefined
      ? []
      : names.map((name) => ({ name, description: '', inputSchema: { type: 'object' } })),
  };
  return new IsolatedAgentInvocationService(
    resources as never,
    {} as never,
    mcpRuntime as never,
    builtinTools as never,
  );
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'workspace_personal',
    publicModelId: 'public/model',
    systemPrompt: 'Role base prompt.',
    context: { goal: 'inspect the exam flow' },
    skills: [dinoSkill],
    mcpRuntimes: [],
    builtinToolNames: ['read'],
    role: 'test_runner',
    projectDirectory: '/tmp/project',
    signal: new AbortController().signal,
    ...overrides,
  } as never;
}

describe('IsolatedAgentInvocationService Skill loading', () => {
  it('uses the default budget and permits a bounded larger investigation budget', async () => {
    gateway.runWorkflowAgent.mockResolvedValue({ text: 'ok' });
    await service().execute(baseRequest());
    expect(gateway.runWorkflowAgent.mock.lastCall?.[0].maxToolRounds).toBe(20);
    await service().execute(baseRequest({ limits: { maxToolRounds: 60 } }));
    expect(gateway.runWorkflowAgent.mock.lastCall?.[0].maxToolRounds).toBe(60);
    await service().execute(baseRequest({ limits: { maxToolRounds: 1000 } }));
    expect(gateway.runWorkflowAgent.mock.lastCall?.[0].maxToolRounds).toBe(100);
    await service().execute(baseRequest({ limits: { maxToolRounds: 30, budgetReminderAtRound: 18 } }));
    expect(gateway.runWorkflowAgent.mock.lastCall?.[0]).toMatchObject({ maxToolRounds: 30, budgetReminderAtRound: 18 });
  });
  it('injects a Coder role Skill and advertises each reference', async () => {
    let captured: { systemPrompt: string; builtinTools: Array<{ name: string }> } | undefined;
    gateway.runWorkflowAgent.mockImplementation(async (request: { systemPrompt: string; builtinTools: Array<{ name: string }> }) => {
      captured = request;
      return { text: 'ok' };
    });

    await service().execute(baseRequest());

    expect(captured?.systemPrompt).toContain('Use `dino-cli account current` to inspect the active account.');
    expect(captured?.systemPrompt).toContain('Skills assigned to this role are already loaded');
    expect(captured?.systemPrompt).toContain('dino-cli (sk_dino)');
    expect(captured?.systemPrompt).toContain('read with skill_reference');
    expect(captured?.systemPrompt).toContain('references/commands.md');
    expect(captured?.builtinTools.map((tool) => tool.name)).toContain('skill_reference');
  });

  it('reads a reference only through an exact captured reference path', async () => {
    let toolResult: { type: string; value: string } | undefined;
    gateway.runWorkflowAgent.mockImplementation(async (request: { executeTool: (call: unknown) => Promise<{ type: string; value: string }> }) => {
      toolResult = await request.executeTool({ toolName: 'skill_reference', input: { skillId: 'sk_dino', path: 'references/commands.md' } });
      return { text: 'ok' };
    });

    await service().execute(baseRequest());

    expect(toolResult).toEqual({
      type: 'text',
      value: expect.stringContaining('account login -e <email> records a web account.'),
    });
  });

  it('rejects a Skill reference path outside the captured references', async () => {
    gateway.runWorkflowAgent.mockImplementation(async (request: { executeTool: (call: unknown) => Promise<unknown> }) => {
      await request.executeTool({ toolName: 'skill_reference', input: { skillId: 'sk_dino', path: 'scripts/check.sh' } });
      return { text: 'ok' };
    });

    await expect(service().execute(baseRequest())).rejects.toThrow('unavailable Skill reference');
  });

  it('keeps Workflow Agent node Skill injection unchanged without adding Coder-only tools', async () => {
    let captured: { systemPrompt: string; builtinTools: Array<{ name: string }> } | undefined;
    gateway.runWorkflowAgent.mockImplementation(async (request: { systemPrompt: string; builtinTools: Array<{ name: string }> }) => {
      captured = request;
      return { text: 'ok' };
    });

    await service().execute(baseRequest({ role: undefined, projectDirectory: undefined, builtinToolNames: [] }));

    expect(captured?.systemPrompt).toContain('Assigned Skill instructions:');
    expect(captured?.systemPrompt).toContain('Use `dino-cli account current` to inspect the active account.');
    expect(captured?.systemPrompt).not.toContain('Skills assigned to this role are already loaded');
    expect(captured?.builtinTools.map((tool) => tool.name)).not.toContain('skill_reference');
  });
});

describe('IsolatedAgentInvocationService managed tool journaling', () => {
  // A journal that records every transition; managed tools are journaled like any effect.
  function journal() {
    const transitions: string[] = [];
    return {
      transitions,
      findOperation: async () => undefined,
      findReplayOperation: async () => undefined,
      reserveOperation: async () => { transitions.push('reserved'); return {} as never; },
      attachReplayCommand: () => undefined,
      completeOperation: async () => { transitions.push('completed'); return {} as never; },
      failOperation: async (_key: string, reason: string) => { transitions.push(`failed: ${reason}`); return {} as never; },
      markOperationUncertain: async (_key: string, reason: string) => { transitions.push(`uncertain: ${reason}`); return {} as never; },
    };
  }

  async function runManagedTool(executeManagedTool: () => Promise<string>) {
    const operations = journal();
    let toolResult: unknown;
    gateway.runWorkflowAgent.mockImplementationOnce(async (request: { executeTool: (call: unknown) => Promise<unknown> }) => {
      toolResult = await request.executeTool({ toolCallId: 'call_1', toolName: 'coder_memory_write', input: { content: 'A fact.' } });
      return { text: 'done' };
    });
    await service().execute(baseRequest({
      managedTools: [{ name: 'coder_memory_write', description: '', inputSchema: { type: 'object' } }],
      executeManagedTool,
      operation: { taskKey: 'group_0_planner', journal: operations },
    }));
    return { toolResult, transitions: operations.transitions };
  }

  it('returns a rejected managed tool request to the model instead of requiring recovery', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    const { toolResult, transitions } = await runManagedTool(async () => {
      throw new BadRequestException('The memory repository is outside this Run repository scope.');
    });
    expect(toolResult).toEqual({ type: 'error-text', value: 'The memory repository is outside this Run repository scope.' });
    expect(transitions).toEqual(['reserved', 'failed: The memory repository is outside this Run repository scope.']);
  });

  it('returns a built-in tool input rejection to the model when no command was started', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    const operations = journal();
    let toolResult: unknown;
    gateway.runWorkflowAgent.mockImplementationOnce(async (request: { executeTool: (call: unknown) => Promise<unknown> }) => {
      toolResult = await request.executeTool({ toolCallId: 'call_1', toolName: 'glob', input: { pattern: '/elsewhere/**' } });
      return { text: 'done' };
    });
    const invocation = new IsolatedAgentInvocationService(
      { publicModelCandidates: async () => [{ provider: { id: 'provider' }, model: 'model' }] } as never,
      { start: async () => { throw new BadRequestException('The glob pattern must be inside the project directory.'); } } as never,
      { discover: async () => [] } as never,
      { toolDefinitions: (names?: readonly string[]) => (names ?? []).map((name) => ({ name, description: '', inputSchema: { type: 'object' } })), start: async () => { throw new BadRequestException('The glob pattern must be inside the project directory.'); } } as never,
    );
    await invocation.execute(baseRequest({ builtinToolNames: ['glob'], operation: { taskKey: 'group_0_planner', journal: operations } }));
    expect(toolResult).toEqual({ type: 'error-text', value: 'The glob pattern must be inside the project directory.' });
    expect(operations.transitions).toEqual([]);
  });

  it('still asks for recovery when a managed tool fails for an unknown reason', async () => {
    await expect(runManagedTool(async () => { throw new Error('database is locked'); }))
      .rejects.toThrow('requires a recovery decision before it can continue');
  });
  it('enforces shared task budget before starting any tool effect', async () => {
    gateway.runWorkflowAgent.mockImplementation(async (request: { executeTool: (call: unknown) => Promise<unknown> }) => {
      expect(await request.executeTool({ toolCallId: 'denied', toolName: 'read', input: { path: 'file' } })).toEqual({ type: 'error-text', value: 'Keep budget for delivery' });
      return { text: 'Partial work' };
    });
    await expect(service().execute(baseRequest({ beforeToolCall: () => 'Keep budget for delivery' }))).resolves.toBe('Partial work');
  });

  it('allows direct inspection and rejects unassigned tools without launching a model', async () => {
    gateway.runWorkflowAgent.mockClear();
    const request = baseRequest({ role: undefined, builtinToolNames: ['read'] });
    const inspected = await service().executeAssignedTool(request);
    expect(JSON.parse(inspected.value)).toMatchObject({ skills: [{ id: 'sk_dino', scripts: ['scripts/check.sh'] }], tools: [{ name: 'read' }] });
    await expect(service().executeAssignedTool(request, { toolCallId: 'no', toolName: 'bash', input: { command: 'echo no' } })).rejects.toThrow('unavailable built-in tool');
    await expect(service().executeAssignedTool(request, { toolCallId: 'no', toolName: 'skill_script', skillId: 'unassigned', scriptPath: 'scripts/check.sh', input: {} })).rejects.toThrow('unavailable Skill script');
    expect(gateway.runWorkflowAgent).not.toHaveBeenCalled();
  });

});
