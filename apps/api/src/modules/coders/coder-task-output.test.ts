import { describe, expect, it, vi } from 'vitest';
import { AgentTeamRuntimeService, parseTaskOutput } from './coder-runtime.service';

describe('Coder task output', () => {
  const completed = { status: 'completed', message: 'Done', documents: [], unresolvedIssues: [], changedFiles: [], completedAssignedWork: true, criterionAssessments: [] };

  it('accepts a complete fenced JSON result and preserves the normal validation', () => {
    const result = parseTaskOutput(`\n\`\`\`json\n${JSON.stringify(completed)}\n\`\`\`\n`, 'task');
    expect(result).toMatchObject(completed);
    expect(() => parseTaskOutput('```json\n{"status":"completed"}\n```', 'task')).toThrow('assigned-work completion');
  });

  it('does not accept prose, multiple objects, or malformed fenced content', () => {
    for (const output of [
      `Here is the result:\n\`\`\`json\n${JSON.stringify(completed)}\n\`\`\``,
      `${JSON.stringify(completed)}\n${JSON.stringify(completed)}`,
      '```json\n{broken}\n```',
    ]) expect(() => parseTaskOutput(output, 'task')).toThrow('invalid JSON');
  });

  it('repairs a malformed result without launching the project executor again', async () => {
    const executor = vi.fn().mockResolvedValue('invalid result');
    const repair = vi.fn().mockResolvedValue(JSON.stringify(completed));
    const runtime = Object.assign(Object.create(AgentTeamRuntimeService.prototype), {
      getRun: vi.fn().mockResolvedValue({ id: 'run', coderId: 'coder' }),
      prepareTaskAttempt: vi.fn().mockResolvedValue({ id: 'attempt', status: 'running' }),
      abortControllers: new Map(),
      resources: { workflowMcpRuntimes: vi.fn().mockResolvedValue([]) },
      executors: { requireModel: vi.fn(), execute: executor },
      invocations: { execute: repair },
      finishCoderOutput: vi.fn(async (_request, _workspace, _attempt, taskKey, output) => parseTaskOutput(output, taskKey)),
    });
    const role = { role: 'executor', executor: 'claude', publicModelId: 'provider/model', instructions: '', skills: [], mcpServers: [] };
    const version = { snapshot: { orchestrationVersion: 7, roles: [role], projectExecutorLaunches: { executor: { executor: 'claude' } } } };
    const request = { runId: 'run', projectDirectory: '/project', outputDirectory: '/output', intent: 'Fix', mode: 'implement_and_validate', scopeRevision: 1, projectInstructions: [], upstream: [], taskDefinition: { role: 'executor', taskKey: 'task' } };
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
