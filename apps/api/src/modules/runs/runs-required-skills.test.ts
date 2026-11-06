import { describe, expect, it, vi } from 'vitest';
import type { WorkflowNodeActivityDetail } from '@worklite/contracts';
import type { Database } from '@worklite/db';
import type { NodeExecutionRequest, NodeTypeRegistry } from '@worklite/workflow-engine';
import type { WorkspaceService } from '../teams/teams.service';
import type { AgentExecutionsService } from '../agents/agent-executions.service';
import type { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import type { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import type { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { AgentJsonOutputError } from '@worklite/model-gateway';
import { assertRequiredSkillScriptCalls, RunsService, workflowAgentFailure } from './runs.service';

type ScriptCall = { skillId: string; skillName: string; exitCode: number | null; failureReason?: string };
type Reporter = (detail: WorkflowNodeActivityDetail) => void | Promise<void>;

function harness(calls: ScriptCall[], response: string | Error = '{"plan":"ok"}') {
  const executeWorkflowAgent = vi.fn(async (...args: unknown[]) => {
    const activity = args[9] as Reporter;
    for (const call of calls) {
      const succeeded = call.exitCode === 0 && !call.failureReason;
      await activity({
        phase: 'skill.script',
        skillId: call.skillId,
        skillName: call.skillName,
        scriptPath: 'scripts/search.mjs',
        arguments: [],
        commandExecutionId: `cmd_${call.skillId}`,
        exitCode: call.exitCode,
        status: succeeded ? 'succeeded' : 'failed',
        ...(call.failureReason ? { failureReason: call.failureReason } : {}),
      });
    }
    if (response instanceof Error) throw response;
    return response;
  });
  // Retired aliases resolve to the canonical id reported by script activity.
  const resolveWorkflowSkillIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) => ids.map((id) => (id === 'sk_old_zhihu' ? 'sk_zhihu' : id)));
  const agentExecutions = { executeWorkflowAgent, resolveWorkflowSkillIds } as unknown as AgentExecutionsService;
  const service = new RunsService({} as Database, {} as WorkspaceService, agentExecutions, { subscribe: () => () => undefined } as unknown as WechatOfficialAccountService, {} as PortkeyGatewayService, {} as ArtifactStorageService);
  const published: WorkflowNodeActivityDetail[] = [];
  (service as unknown as { publishActivity: (...args: unknown[]) => Promise<void> }).publishActivity = async (...args: unknown[]) => { published.push(args[3] as WorkflowNodeActivityDetail); };
  const registry = (service as unknown as { registry: NodeTypeRegistry }).registry;
  const execute = (config: Record<string, unknown>) => registry.resolve('worklite/agent', '1').execute({
    input: { context: { topic: 'x' } },
    config: { model: 'GLM/glm-5.3', systemPrompt: 'research', skillIds: ['sk_tavily', 'sk_github', 'sk_old_zhihu'], mcpServerIds: [], outputFormat: 'json', ...config },
    context: { workspaceId: 'workspace_personal', workflowId: 'wf', workflowRunId: 'run', workflowVersionId: 'wfv', nodeId: 'research', nodeRunId: 'nr', pendingActionId: 'pa', variables: {} },
    signal: new AbortController().signal,
  } as NodeExecutionRequest);
  return { execute, published, executeWorkflowAgent };
}

const required = { requiredSkillIds: ['sk_tavily', 'sk_github', 'sk_old_zhihu'] };

describe('Workflow Agent requiredSkillIds', () => {
  it('passes when every required Skill has a script call that exited 0, including empty results', async () => {
    const { execute, published } = harness([
      { skillId: 'sk_tavily', skillName: 'tavily-web-research', exitCode: 0 },
      { skillId: 'sk_github', skillName: 'github-research', exitCode: 0 },
      { skillId: 'sk_zhihu', skillName: 'zhihu-research', exitCode: 0 },
    ], '{"plan":"ok","findings":[]}');
    await expect(execute(required)).resolves.toEqual({ output: { plan: 'ok', findings: [] } });
    expect(published.filter((detail) => detail.phase === 'skill.script')).toHaveLength(3);
  });

  it('fails the node when a required Skill was never called, even if the model claims success', async () => {
    const { execute } = harness([
      { skillId: 'sk_tavily', skillName: 'tavily-web-research', exitCode: 0 },
      { skillId: 'sk_zhihu', skillName: 'zhihu-research', exitCode: 0 },
    ], '{"plan":"all channels queried"}');
    await expect(execute(required)).rejects.toThrow('Required research Skill sk_github has no successful script call.');
  });

  it('fails the node when a required Skill only exited non-zero and reports the last exit code', async () => {
    const { execute } = harness([
      { skillId: 'sk_tavily', skillName: 'tavily-web-research', exitCode: 0 },
      { skillId: 'sk_github', skillName: 'github-research', exitCode: 0 },
      { skillId: 'sk_zhihu', skillName: 'zhihu-research', exitCode: 2 },
    ]);
    await expect(execute(required)).rejects.toThrow('Required research Skill zhihu-research has no successful script call (last exit code 2).');
  });

  it('accepts a failed call followed by a successful retry and ignores Skills that are not required', async () => {
    const { execute } = harness([
      { skillId: 'sk_github', skillName: 'github-research', exitCode: 1 },
      { skillId: 'sk_github', skillName: 'github-research', exitCode: 0 },
    ]);
    await expect(execute({ requiredSkillIds: ['sk_github'] })).resolves.toEqual({ output: { plan: 'ok' } });
    await expect(harness([]).execute({})).resolves.toEqual({ output: { plan: 'ok' } });
  });

  it('checks the requirement directly from script call records', () => {
    expect(() => assertRequiredSkillScriptCalls([], [])).not.toThrow();
    expect(() => assertRequiredSkillScriptCalls(['a'], [{ skillId: 'a', skillName: 'A', exitCode: null, status: 'failed' }])).toThrow('Required research Skill A has no successful script call (last exit code unknown).');
    expect(() => assertRequiredSkillScriptCalls(['a'], [{ skillId: 'a', skillName: 'A', exitCode: 0, status: 'failed', failureReason: 'excessive requests' }])).toThrow('Required research Skill A has no successful script call (last exit code 0: excessive requests).');
  });

  it('reports the failed required channel instead of the JSON error when the model then stops with prose', async () => {
    const { execute } = harness([
      { skillId: 'sk_tavily', skillName: 'tavily-web-research', exitCode: 0, failureReason: 'excessive requests' },
      { skillId: 'sk_github', skillName: 'github-research', exitCode: 0 },
      { skillId: 'sk_zhihu', skillName: 'zhihu-research', exitCode: 0 },
    ], new AgentJsonOutputError('tavily-web-research 被限流（excessive requests），按三渠道必须成功的规则停止。'));
    const error = await execute(required).then(() => null, (reason: unknown) => reason as Error);
    expect(error?.message).toBe('Required research Skill tavily-web-research has no successful script call (last exit code 0: excessive requests).');
  });

  it('adds a bounded excerpt of the model reply to a JSON error when every required channel succeeded', async () => {
    const prose = `我已经完成调研。\n\n   ${'细节'.repeat(400)}`;
    const { execute } = harness([
      { skillId: 'sk_tavily', skillName: 'tavily-web-research', exitCode: 0 },
      { skillId: 'sk_github', skillName: 'github-research', exitCode: 0 },
      { skillId: 'sk_zhihu', skillName: 'zhihu-research', exitCode: 0 },
    ], new AgentJsonOutputError(prose));
    const error = await execute(required).then(() => null, (reason: unknown) => reason as Error);
    expect(error?.message).toContain('Agent JSON output requires valid JSON.');
    expect(error?.message).toContain('Model reply: 我已经完成调研。 细节细节');
    expect(error!.message.length).toBeLessThan(600);
  });

  it('passes other model errors through unchanged', async () => {
    const failure = new Error('Gateway unavailable.');
    const { execute } = harness([], failure);
    await expect(execute({})).rejects.toBe(failure);
    expect(workflowAgentFailure(failure)).toBe(failure);
  });
});
