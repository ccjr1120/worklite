import { describe, expect, it, vi } from 'vitest';
import { AgentTeamRuntimeService, parseTaskOutput } from './coder-runtime.service';

describe('Coder task output', () => {
  const completed = { status: 'completed', message: 'Done', documents: [], unresolvedIssues: [], changedFiles: [], completedWork: true, criterionAssessments: [] };

  it('accepts a complete fenced JSON result and preserves the normal validation', () => {
    const result = parseTaskOutput(`\n\`\`\`json\n${JSON.stringify(completed)}\n\`\`\`\n`, 'task');
    expect(result).toMatchObject(completed);
    expect(() => parseTaskOutput('```json\n{"status":"completed"}\n```', 'task')).toThrow('task completion');
  });

  it('does not accept prose, multiple objects, or malformed fenced content', () => {
    for (const output of [
      `Here is the result:\n\`\`\`json\n${JSON.stringify(completed)}\n\`\`\``,
      `${JSON.stringify(completed)}\n${JSON.stringify(completed)}`,
      '```json\n{broken}\n```',
    ]) expect(() => parseTaskOutput(output, 'task')).toThrow('invalid JSON');
  });

  it('accepts Router plans only for configured work roles and rejects cycles or Router self-assignment', () => {
    const plan = parseTaskOutput(JSON.stringify({
      ...completed,
      routerPlan: { action: 'dispatch', assignments: [
        { id: 'inspect', role: 'reviewer', goal: 'Review the changed paths', dependencyIds: [] },
        { id: 'summarize', role: 'planner', goal: 'Summarize the review', dependencyIds: ['inspect'] },
      ] },
    }), 'router', ['reviewer', 'planner']);
    expect(plan).toMatchObject({ routerPlan: { action: 'dispatch', assignments: [
      { id: 'inspect', role: 'reviewer', goal: 'Review the changed paths' },
      { id: 'summarize', role: 'planner', dependencyIds: ['inspect'] },
    ] } });

    for (const invalidPlan of [
      { action: 'dispatch', assignments: [{ id: 'unknown', role: 'unconfigured', goal: 'Do work' }] },
      { action: 'dispatch', assignments: [{ id: 'router', role: 'router', goal: 'Route work' }] },
      { action: 'dispatch', assignments: [
        { id: 'first', role: 'reviewer', goal: 'Review', dependencyIds: ['second'] },
        { id: 'second', role: 'planner', goal: 'Plan', dependencyIds: ['first'] },
      ] },
    ]) {
      expect(() => parseTaskOutput(JSON.stringify({ ...completed, routerPlan: invalidPlan }), 'router', ['reviewer', 'planner']))
        .toThrow(/configured work roles|cycle/);
    }
  });

  it('allows Router to finish directly without assigning a role', () => {
    expect(parseTaskOutput(JSON.stringify({ ...completed, routerPlan: { action: 'finish' } }), 'router', ['reviewer']))
      .toMatchObject({ routerPlan: { action: 'finish' } });
  });

  it('rejects output fields from the retired dispatch and handoff protocol', () => {
    for (const field of ['handoff', 'dispatchDecision', 'developmentAssignments', 'repairRequests']) {
      expect(() => parseTaskOutput(JSON.stringify({ ...completed, [field]: {} }), 'task'))
        .toThrow(`unsupported field: ${field}`);
    }
  });

  it('repairs a malformed result without launching the project executor again', async () => {
    const executor = vi.fn().mockResolvedValue('invalid result');
    const repair = vi.fn().mockResolvedValue(JSON.stringify(completed));
    const runtime = Object.assign(Object.create(AgentTeamRuntimeService.prototype), {
      getRun: vi.fn().mockResolvedValue({ id: 'run', coderId: 'coder' }),
      prepareTaskAttempt: vi.fn().mockResolvedValue({ id: 'attempt', status: 'running' }),
      abortControllers: new Map(),
      taskAbortControllers: new Map(),
      db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ status: 'running' }]) })) })) })) },
      resources: { workflowMcpRuntimes: vi.fn().mockResolvedValue([]) },
      memoryTokens: { register: vi.fn().mockReturnValue(null), revoke: vi.fn() },
      executors: { requireModel: vi.fn(), execute: executor },
      invocations: { execute: repair },
      finishCoderOutput: vi.fn(async (_request, _workspace, _attempt, taskKey, output) => parseTaskOutput(output, taskKey)),
    });
    const role = { role: 'implementer', executor: 'claude', publicModelId: 'provider/model', instructions: '', skills: [], mcpServers: [] };
    const version = { snapshot: { orchestrationVersion: 12, roles: [role], projectExecutorLaunches: { implementer: { executor: 'claude' } } } };
    const request = { runId: 'run', projectDirectory: '/project', outputDirectory: '/output', intent: 'Fix', scopeRevision: 1, projectInstructions: [], upstream: [], groupContext: { groupId: 'group', initialMessageId: 'message', initialMessage: 'Fix', targetRole: 'router', repositories: [], memories: [] }, taskDefinition: { role: 'implementer', taskKey: 'task' } };
    const execute = Reflect.get(AgentTeamRuntimeService.prototype, 'executeTask');
    await expect(execute.call(runtime, 'workspace', version, request)).resolves.toMatchObject(completed);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair.mock.calls[0][0]).toMatchObject({ builtinToolNames: [], skills: [], mcpRuntimes: [], context: { previousReply: 'invalid result' } });

    executor.mockClear().mockResolvedValue(`\`\`\`json\n${JSON.stringify(completed)}\n\`\`\``);
    repair.mockClear();
    await expect(execute.call(runtime, 'workspace', version, request)).resolves.toMatchObject(completed);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();

    role.publicModelId = 'native-model';
    executor.mockClear().mockResolvedValue('invalid result');
    await expect(execute.call(runtime, 'workspace', version, request)).rejects.toThrow('without a configured Gateway model');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
  });
});
