import type { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import { realpath } from 'node:fs/promises';
import type { ProjectExecutorService } from './project-executor.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { commandExecutions, agentCapabilityResults, artifacts, auditLogs, agentExecutions, agents, agentToolCalls, createDb, initializeDatabase, type Database } from '@worklite/db';
import type { WorkflowAgentToolCall } from '@worklite/model-gateway';
import type { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { AgentCapabilitiesService } from './agent-capabilities.service';
import type { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';
import { AgentCollaborationService } from './agent-collaboration.service';

let db: Database;
afterEach(() => db?.$client.close());
type Invocation = Parameters<IsolatedAgentInvocationService['execute']>[0];
const tool = (toolName: string, input: unknown): WorkflowAgentToolCall => ({ toolName, input, toolCallId: `model-${toolName}` });
async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  for (const id of ['lead', 'researcher', 'writer']) db.insert(agents).values({ id, workspaceId: 'workspace_personal', name: id, kind: 'custom', responsibility: `Purpose of ${id}`, systemPrompt: id, model: 'provider/model', collaboration: { subAgentIds: id === 'lead' ? ['researcher', 'writer'] : [], capabilities: id === 'lead' ? [{ id: 'image', type: 'worklite/image', typeVersion: '1', config: {} }] : [], publicModels: ['provider/model'] } }).run();
  db.insert(agentExecutions).values({ id: 'execution', workspaceId: 'workspace_personal', agentId: 'lead', status: 'running' }).run();
  const execute = vi.fn<(request: Invocation) => Promise<string>>();
  const capability = vi.fn<AgentCapabilitiesService['execute']>();
  const resources = { resolveSkillIds: async (_workspace: string, ids: string[]) => ids, workflowMcpRuntimes: async () => [] } as unknown as WorkspaceResourcesService;
  const executeEngine = vi.fn<ProjectExecutorService['execute']>(async () => 'Engine result');
  const executors = { captureLaunch: async () => ({ executor: 'codex', model: 'provider/model', commandArguments: [] }), execute: executeEngine } as unknown as ProjectExecutorService;
  const builtinTools = { start: vi.fn(async () => ({ id: 'command-private' })), wait: vi.fn(async () => ({ execution: { exitCode: 0 }, output: 'Saved' })), cancel: vi.fn(async () => ({})) };
  const executeAssignedTool = vi.fn<IsolatedAgentInvocationService['executeAssignedTool']>(async () => ({ type: 'text', value: 'Existing evidence' }));
  const newService = () => new AgentCollaborationService(db, resources, { execute, executeAssignedTool } as unknown as IsolatedAgentInvocationService, { execute: capability } as unknown as AgentCapabilitiesService, executors, builtinTools as unknown as BuiltinAgentToolsService);
  return { service: newService(), newService, execute, capability, executeEngine, builtinTools, executeAssignedTool };
}

describe('Agent-selected collaboration', () => {
  it('attributes empty-model Codex snapshots to the exact invocation and replaces usage when that session continues', async () => {
    const { service, newService, execute, executeEngine } = await setup();
    db.update(agents).set({ runtime: { kind: 'codex', projectDirectory: process.cwd() }, providerId: null, model: '', collaboration: { subAgentIds: [], capabilities: [], publicModels: [] } }).where(eq(agents.id, 'researcher')).run();
    let childRunId = '';
    executeEngine.mockImplementationOnce(async (request) => {
      expect(request.model).toBeNull();
      expect(request.correlation).toMatchObject({ agentExecutionId: 'execution', agentRunId: expect.stringMatching(/^air_/) });
      childRunId = request.correlation!.agentRunId!;
      await request.runtimeSession!.onSession('codex-thread');
      await request.onEvent?.({ phase: 'codex.started', commandExecutionId: 'command-first' });
      for (const totalTokens of [35, 120, 120]) await request.onEvent?.({ phase: 'codex.usage', commandExecutionId: 'command-first', usage: { inputTokens: totalTokens - 20, outputTokens: 20, totalTokens, cacheReadTokens: 10, cacheCreationTokens: null } });
      throw new Error('Interrupted after usage');
    });
    execute.mockImplementationOnce(async (request) => {
      const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', task: 'Implement' })) as string);
      expect(receipt.result.status).toBe('failed');
      return 'Failure reported';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Implement', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, childRunId)).get()?.metadata).toMatchObject({ parentRunId: 'air_lead', status: 'failed', commandExecutionId: 'command-first', usage: { totalTokens: 120, cacheReadTokens: 10, cacheCreationTokens: null } });
    executeEngine.mockImplementationOnce(async (request) => {
      expect(request.runtimeSession?.resumeId).toBe('codex-thread');
      await request.onEvent?.({ phase: 'codex.usage', commandExecutionId: 'command-resumed', usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 } });
      return 'Finished';
    });
    execute.mockImplementationOnce(async (request) => {
      await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', runId: childRunId, task: 'Continue' }));
      return 'Done';
    });
    await newService().run('workspace_personal', 'execution', 'lead', 'Continue', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, childRunId)).get()?.metadata).toMatchObject({ status: 'completed', commandExecutionId: 'command-resumed', usage: { totalTokens: 180 } });
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all()).toHaveLength(2);
  });

  it('keeps the Codex command attribution and unknown usage if startup fails before any token report', async () => {
    const { service, executeEngine } = await setup();
    db.update(agents).set({ runtime: { kind: 'codex', projectDirectory: process.cwd() } }).where(eq(agents.id, 'lead')).run();
    executeEngine.mockImplementationOnce(async (request) => {
      await request.onEvent?.({ phase: 'codex.started', commandExecutionId: 'command-startup' });
      throw new Error('No usage reported');
    });
    await expect(service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal)).rejects.toThrow('No usage reported');
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).get()?.metadata).toMatchObject({ status: 'failed', commandExecutionId: 'command-startup', usage: null });
  });

  it('asks the original native specialist with saved evidence across lead continuations', async () => {
    const { service, execute } = await setup();
    let childRunId = '';
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('researcher')) {
        await request.onMessages?.([{ role: 'user', content: 'Original task' }, { role: 'assistant', content: [{ type: 'text', text: 'Implemented with evidence' }] }]);
        return 'Implemented with evidence';
      }
      const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', task: 'Implement' })) as string);
      childRunId = receipt.result.runId;
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Implement', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('researcher')) {
        expect(request.initialMessages).toEqual([{ role: 'user', content: 'Original task' }, { role: 'assistant', content: [{ type: 'text', text: 'Implemented with evidence' }] }, { role: 'user', content: '"Explain the change"' }]);
        return 'Explanation from saved context';
      }
      const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', runId: childRunId, task: 'Explain the change' })) as string);
      expect(receipt.result).toMatchObject({ runId: childRunId, status: 'completed', result: 'Explanation from saved context' });
      return 'Explained';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Explain', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all()).toHaveLength(2);
  });

  it.each(['codex', 'claude'] as const)('persists and continues the original %s session after the lead ends', async (kind) => {
    const { service, newService, execute, executeEngine } = await setup();
    db.update(agents).set({ runtime: { kind, projectDirectory: process.cwd() } }).where(eq(agents.id, 'researcher')).run();
    let childRunId = '';
    executeEngine.mockImplementationOnce(async (request) => {
      await request.runtimeSession!.onSession('saved-engine-session');
      return 'Implemented';
    });
    execute.mockImplementationOnce(async (request) => {
      const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', task: 'Implement' })) as string);
      childRunId = receipt.result.runId;
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Implement', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    executeEngine.mockImplementationOnce(async (request) => {
      expect(request.runtimeSession!.resumeId).toBe('saved-engine-session');
      expect(request.input).toBe('"Explain the change"');
      return 'Explained';
    });
    execute.mockImplementationOnce(async (request) => {
      const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', runId: childRunId, task: 'Explain the change', background: true })) as string);
      expect(receipt.result.runId).toBe(childRunId);
      const result = JSON.parse(await request.executeManagedTool!(tool('wait_sub_agent', { runId: childRunId })) as string);
      expect(result.result.result).toBe('Explained');
      return 'Done';
    });
    await newService().run('workspace_personal', 'execution', 'lead', 'Explain', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    expect(executeEngine).toHaveBeenCalledTimes(2);
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all()).toHaveLength(2);
  });

  it('rejects foreign, unsettled and legacy invocations without launching replacement work', async () => {
    const { service, execute, executeEngine } = await setup();
    db.update(agents).set({ runtime: { kind: 'codex', projectDirectory: process.cwd() } }).where(eq(agents.id, 'writer')).run();
    const base = { id: 'air_old', agentId: 'researcher', parentRunId: 'air_lead', status: 'completed' };
    db.insert(auditLogs).values({ id: base.id, workspaceId: 'workspace_personal', action: 'agent.invocation', resource: 'execution', metadata: base }).run();
    execute.mockImplementationOnce(async (request) => {
      for (const patch of [{ agentId: 'writer' }, { parentRunId: 'another-parent' }, { status: 'running' }, { status: 'completed' }]) {
        db.update(auditLogs).set({ metadata: { ...base, ...patch } }).where(eq(auditLogs.id, base.id)).run();
        const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', runId: base.id, task: 'Explain' })) as string);
        expect(receipt.result.status).toBe('failed');
      }
      const receipt = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', runId: 'air_missing', task: 'Explain' })) as string);
      expect(receipt.result.status).toBe('failed');
      const background = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', runId: 'air_missing', task: 'Explain', background: true })) as string);
      expect(background.result.status).toBe('failed');
      return 'Unavailable';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Explain', new AbortController().signal, undefined, undefined, undefined, 'air_lead');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executeEngine).not.toHaveBeenCalled();
  });

  it('saves successful research before the lead completes, without saving failed output', async () => {
    const { service, execute } = await setup();
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('researcher')) return 'Research findings';
      if (request.systemPrompt.startsWith('writer')) throw new Error('Failed writing');
      await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', task: 'Research' }));
      expect(db.select().from(artifacts).all()).toMatchObject([{ name: 'researcher', content: 'Research findings' }]);
      await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Write' }));
      expect(db.select().from(artifacts).all()).toHaveLength(1);
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Task', new AbortController().signal);
  });

  it('continues the original lead invocation with its saved model history and result references', async () => {
    const { service, execute } = await setup();
    execute.mockImplementationOnce(async (request) => {
      await request.onMessages?.([{ role: 'user', content: 'Original' }, { role: 'assistant', content: [{ type: 'text', text: 'Research complete' }] }]);
      return 'First version';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Original', new AbortController().signal, undefined, undefined, undefined, 'air_original');
    const saved = db.select().from(agentExecutions).where(eq(agentExecutions.id, 'execution')).get()!;
    db.update(agentExecutions).set({ modelMessages: [...saved.modelMessages, { role: 'user', content: 'Change the title' }] }).where(eq(agentExecutions.id, 'execution')).run();
    db.update(agents).set({ collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/new-model'] } }).where(eq(agents.id, 'lead')).run();
    execute.mockImplementationOnce(async (request) => {
      expect(request.publicModelId).toEqual(['provider/new-model']);
      expect(request.initialMessages).toEqual([...saved.modelMessages, { role: 'user', content: 'Change the title' }]);
      return 'Revised version';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Change the title', new AbortController().signal, undefined, undefined, undefined, 'air_original');
    const runs = db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 'air_original', resource: 'execution', metadata: { task: 'Original', status: 'completed', output: 'Revised version' } });
  });

  it('persists live activity and partial output while a run is in progress', async () => {
    const { service, execute } = await setup();
    const current = () => db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).get()!.metadata;
    execute.mockImplementationOnce(async (request) => {
      expect(current()).toMatchObject({ status: 'running', currentActivity: { phase: 'model' } });
      request.beforeToolCall?.(tool('bash', { command: 'pwd' }));
      expect(current()).toMatchObject({ currentActivity: { phase: 'tool', toolName: 'bash' } });
      await request.onBuiltinTool?.({ toolName: 'bash', input: {}, commandExecutionId: 'command', exitCode: 0, status: 'succeeded' });
      expect(current()).toMatchObject({ currentActivity: { phase: 'model' } });
      await request.onTextDelta?.('Partial response');
      expect(current()).toMatchObject({ output: 'Partial response' });
      return 'Final response';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Task', new AbortController().signal);
    expect(current()).toMatchObject({ status: 'completed', currentActivity: null, output: 'Final response' });
  });

  it('resumes a private capability with the original operation and arguments', async () => {
    const { service, execute, capability } = await setup();
    db.update(agents).set({ collaboration: { subAgentIds: [], capabilities: [{ id: 'publish', type: 'wechat-official-account/publish', typeVersion: '2', config: {} }], publicModels: ['provider/model'], privateTools: [{ name: 'publish_private', description: 'Publish article', inputSchema: { type: 'object', properties: { input: {}, resumeCallId: { type: 'string' } } }, handler: { kind: 'capability', capabilityId: 'publish' } }] } }).where(eq(agents.id, 'lead')).run();
    capability.mockResolvedValueOnce({ status: 'waiting_for_input', pendingAction: { id: 'action-private', type: 'wechat_login', title: 'Login', description: 'Scan to log in', qrCode: 'private-qr' } }).mockResolvedValueOnce({ status: 'completed' });
    execute.mockImplementation(async (request) => {
      const first = JSON.parse(await request.executeManagedTool!(tool('publish_private', { input: { article: 'Original' } })));
      expect(first.result.status).toBe('waiting_for_input');
      expect(first.result).not.toHaveProperty('qrCode');
      const second = JSON.parse(await request.executeManagedTool!(tool('publish_private', { input: { article: 'Changed' }, resumeCallId: first.result.callId })));
      expect(second.result.status).toBe('completed');
      return 'Complete';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Publish', new AbortController().signal);
    expect(capability.mock.calls[1]?.[2]).toBe(capability.mock.calls[0]?.[2]);
    expect(capability.mock.calls[1]?.[4]).toEqual({ article: 'Original' });
  });

  it('executes a saved private command with data arguments and records the command reference', async () => {
    const { service, execute, builtinTools } = await setup();
    db.insert(commandExecutions).values({ id: 'command-private', command: 'node save.mjs', cwd: '/tmp', status: 'succeeded', exitCode: 0 }).run();
    db.update(agents).set({ collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'], privateTools: [{ name: 'save_private', description: 'Save a file', inputSchema: { type: 'object' }, handler: { kind: 'command', command: 'node save.mjs', workingDirectory: '/tmp' } }] } }).where(eq(agents.id, 'lead')).run();
    execute.mockImplementation(async (request) => {
      const result = JSON.parse(await request.executeManagedTool!(tool('save_private', { title: '$(touch /tmp/never-run)' })));
      expect(result.result).toBe('Saved');
      return 'Complete';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Save', new AbortController().signal);
    expect(builtinTools.start).toHaveBeenCalledWith('bash', { command: expect.stringMatching(/^export WORKLITE_TOOL_INPUT_BASE64='[A-Za-z0-9+/=]+'\nnode save.mjs$/) }, { cwd: '/tmp' });
    const call = db.select().from(agentToolCalls).all()[0]!;
    expect(call.commandExecutionId).toBe('command-private');
    expect(call.status).toBe('completed');
    builtinTools.wait.mockResolvedValueOnce({ execution: { exitCode: 1 }, output: 'Failed' });
    execute.mockImplementation(async (request) => {
      const result = JSON.parse(await request.executeManagedTool!(tool('save_private', {})));
      expect(result.status).toBe('failed');
      expect(result.error).toContain('exited with code 1');
      return 'Failed';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Save', new AbortController().signal);
  });

  it('exposes private tools only to the owning Agent and executes their assigned capability', async () => {
    const { service, execute, capability } = await setup();
    const lead = db.select().from(agents).where(eq(agents.id, 'lead')).get()!;
    db.update(agents).set({ collaboration: { ...lead.collaboration!, privateTools: [{ name: 'draw_private', description: 'Draw an image', inputSchema: { type: 'object', properties: { input: {} } }, handler: { kind: 'capability', capabilityId: 'image' } }] } }).where(eq(agents.id, 'lead')).run();
    capability.mockResolvedValue({ image: 'done' });
    execute.mockImplementation(async (request) => {
      if (!request.systemPrompt.startsWith('lead')) {
        expect(request.managedTools?.map((item) => item.name)).not.toContain('draw_private');
        const denied = JSON.parse(await request.executeManagedTool!(tool('draw_private', { input: {} })));
        expect(denied.status).toBe('failed');
        return 'Child';
      }
      expect(request.managedTools?.map((item) => item.name)).toContain('draw_private');
      const result = JSON.parse(await request.executeManagedTool!(tool('draw_private', { input: { prompt: 'A flower' } })));
      expect(result.result).toEqual({ image: 'done' });
      await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Review' }));
      return 'Complete';
    });
    expect(await service.run('workspace_personal', 'execution', 'lead', 'Draw', new AbortController().signal)).toBe('Complete');
    expect(capability).toHaveBeenCalledTimes(1);
    expect(capability.mock.calls[0]?.[4]).toEqual({ prompt: 'A flower' });
    expect(db.select().from(agentToolCalls).all().find((call) => call.mcpToolName === 'draw_private' && call.status === 'completed')).toBeTruthy();
  });

  it('lists only public Agents without exposing their private sub-Agents', async () => {
    const { service } = await setup();
    db.insert(agents).values({ id: 'nested', workspaceId: 'workspace_personal', name: 'Nested', kind: 'custom', responsibility: '', systemPrompt: '', model: '' }).run();
    db.update(agents).set({ collaboration: { subAgentIds: ['nested'], capabilities: [] } }).where(eq(agents.id, 'writer')).run();
    db.insert(agents).values({ id: 'elsewhere', workspaceId: 'workspace_personal', name: 'Standalone', kind: 'custom', responsibility: '', systemPrompt: '', model: '' }).run();
    expect(service.list('workspace_personal')).toEqual([
      { id: 'lead', name: 'lead', responsibility: 'Purpose of lead' },
      { id: 'elsewhere', name: 'Standalone', responsibility: '' },
    ]);
  });

  it('prevents Chat from dispatching a private sub-Agent directly', async () => {
    const { service, execute, executeEngine } = await setup();
    await expect(service.run('workspace_personal', 'execution', 'writer', 'Task', new AbortController().signal)).rejects.toThrow('Sub-Agents are private');
    expect(execute).not.toHaveBeenCalled();
    expect(executeEngine).not.toHaveBeenCalled();
    expect(db.select().from(auditLogs).all()).toEqual([]);
  });

  it('lets the lead choose parallel specialists and then adapt its next task to their results', async () => {
    const { service, execute } = await setup();
    const started: string[] = [];
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('lead')) {
        const parallel = JSON.parse(await request.executeManagedTool!(tool('run_sub_agents', { tasks: [{ agentId: 'writer', task: 'draft' }, { agentId: 'researcher', task: 'facts' }] })));
        expect(parallel.result.map((item: { agentId: string }) => item.agentId)).toEqual(['writer', 'researcher']);
        const next = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: { $result: parallel.resultRef, path: '$.1.result' } })));
        expect(next.result.result).toBe('finished');
        return 'Complete';
      }
      started.push(request.systemPrompt.split('\n')[0]!);
      if (started.length === 2) release();
      await both;
      if (started.length > 2) expect(request.context).toBe('facts');
      return request.systemPrompt.startsWith('researcher') ? 'facts' : 'finished';
    });
    expect(await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal)).toBe('Complete');
    expect(started).toEqual(['writer', 'researcher', 'writer']);
    expect(db.select().from(agentToolCalls).all().every((call) => call.resultAppended && call.status === 'completed')).toBe(true);
  });

  it('records per-invocation usage, repeated sub-Agent calls and failures independently', async () => {
    const { service, execute } = await setup();
    execute.mockImplementation(async (request) => {
      await request.onModelRound?.({ round: 1, model: 'provider/model', finishReason: 'stop', toolCalls: 0, contextDropped: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: null } });
      if (request.systemPrompt.startsWith('lead')) {
        await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'first' }));
        await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'fail' }));
        return 'Done';
      }
      if (request.context === 'fail') throw new Error('Writer failed');
      await request.onModelRound?.({ round: 2, model: 'provider/model', finishReason: 'stop', toolCalls: 0, contextDropped: 0, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, reasoningTokens: null } });
      return 'Draft';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
    const runs = db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all().map((row) => row.metadata);
    const root = runs.find((run) => run.agentId === 'lead')!;
    expect(root.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const children = runs.filter((run) => run.agentId === 'writer');
    expect(children).toHaveLength(2);
    expect(children.every((run) => run.parentRunId === root.id)).toBe(true);
    expect(children.find((run) => run.task === 'first')).toMatchObject({ output: 'Draft', usage: { totalTokens: 40 } });
    expect(children.find((run) => run.task === 'fail')).toMatchObject({ status: 'failed', usage: { totalTokens: 15 } });
  });

  it('binds a clicked Chat mention to the exact root invocation', async () => {
    const { service, execute } = await setup();
    db.update(agentExecutions).set({ displayMessages: [{ id: 'message', role: 'user', content: '[@lead](/agents/lead?runId=air_selected-work) Update one image', createdAt: new Date().toISOString() }] }).where(eq(agentExecutions.id, 'execution')).run();
    execute.mockResolvedValue('Updated');
    await service.run('workspace_personal', 'execution', 'lead', 'Update one image', new AbortController().signal);
    expect(db.select().from(auditLogs).where(eq(auditLogs.id, 'air_selected-work')).get()?.metadata).toMatchObject({ agentId: 'lead', output: 'Updated' });
  });
  it('passes image results by execution-scoped reference without sending base64 back to the model', async () => {
    const { service, execute, capability } = await setup();
    capability.mockResolvedValueOnce({ data: [{ b64Json: 'large-image-bytes' }] }).mockResolvedValueOnce('stored');
    execute.mockImplementation(async (request) => {
      const first = await request.executeManagedTool!(tool('use_capability', { capabilityId: 'image', input: { prompt: 'draw' } }));
      expect(first).not.toContain('large-image-bytes');
      const ref = JSON.parse(first).resultRef as string;
      await request.executeManagedTool!(tool('use_capability', { capabilityId: 'image', input: { coverImage: { $result: ref } } }));
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
    expect(capability.mock.calls[1]?.[4]).toEqual({ coverImage: { data: [{ b64Json: 'large-image-bytes' }] } });
    expect(db.select().from(agentCapabilityResults).all()).toHaveLength(2);
  });

  it('rejects an unassigned specialist and unknown capability before invoking them', async () => {
    const { service, execute, capability } = await setup();
    execute.mockImplementation(async (request) => {
      expect(JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'other', task: 'x' })))).toMatchObject({ status: 'failed' });
      expect(JSON.parse(await request.executeManagedTool!(tool('use_capability', { capabilityId: 'other' })))).toMatchObject({ status: 'failed' });
      return 'Cannot do that';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(1); expect(capability).not.toHaveBeenCalled();
  });

  it('lets a native lead call an engine-backed sub-Agent in the task project directory', async () => {
    const { service, execute, executeEngine } = await setup();
    db.update(agents).set({ runtime: { kind: 'codex', projectDirectory: '' } }).where(eq(agents.id, 'writer')).run();
    const controller = new AbortController();
    execute.mockImplementation(async (request) => {
      const response = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Implement the change' })));
      expect(response.result.result).toBe('Engine result');
      return 'Complete';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', controller.signal, undefined, '/tmp');
    expect(executeEngine).toHaveBeenCalledWith(expect.objectContaining({ owner: 'agent', projectDirectory: await realpath('/tmp'), signal: controller.signal, model: 'provider/model' }));
  });

  it.each(['claude', 'codex'] as const)('pauses one %s instance and resumes its saved engine session without stopping a sibling', async (kind) => {
    const { service, execute, executeEngine } = await setup();
    db.update(agents).set({ runtime: { kind, projectDirectory: '' } }).where(eq(agents.id, 'writer')).run();
    const ready: Array<() => void> = [];
    const started = [0, 1].map(() => new Promise<void>((resolve) => ready.push(resolve)));
    const signals: AbortSignal[] = [];
    executeEngine.mockImplementation(async (request) => {
      if (request.runtimeSession?.resumeId) {
        expect(request.runtimeSession.resumeId).toBe('session-0');
        expect(request.input).toContain('Continue the interrupted task');
        return 'Resumed result';
      }
      const index = signals.push(request.signal) - 1;
      await request.runtimeSession!.onSession(`session-${index}`);
      ready[index]!();
      if (index === 1) return 'Sibling result';
      return new Promise<string>((_resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      });
    });
    execute.mockImplementation(async (request) => {
      const invoke = async (name: string, input: unknown) => JSON.parse(await request.executeManagedTool!(tool(name, input)));
      const first = (await invoke('run_sub_agent', { agentId: 'writer', task: 'First', background: true })).result;
      const sibling = (await invoke('run_sub_agent', { agentId: 'writer', task: 'Second', background: true })).result;
      await Promise.all(started);
      expect(first.runId).not.toBe(sibling.runId);
      await expect(service.controlInstance('another-workspace', 'execution', first.runId, 'pause')).rejects.toThrow('not found');
      await expect(service.controlInstance('workspace_personal', 'execution', first.runId, 'pause', 'another-parent')).rejects.toThrow('not found');
      expect(await invoke('pause_sub_agent', { runId: first.runId })).toMatchObject({ result: { status: 'paused' } });
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      expect(db.select().from(auditLogs).where(eq(auditLogs.id, first.runId)).get()!.metadata).toMatchObject({ status: 'paused', finishedAt: null });
      expect((await invoke('resume_sub_agent', { runId: first.runId })).result.status).toBe('running');
      expect((await invoke('wait_sub_agent', { runId: first.runId })).result.result).toBe('Resumed result');
      expect((await invoke('wait_sub_agent', { runId: sibling.runId })).result.result).toBe('Sibling result');
      return 'Complete';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal, undefined, '/tmp');
    expect(executeEngine).toHaveBeenCalledTimes(3);
    const childRuns = db.select().from(auditLogs).where(eq(auditLogs.action, 'agent.invocation')).all().filter((row) => (row.metadata as { parentRunId: string | null }).parentRunId);
    expect(childRuns).toHaveLength(2);
    expect(childRuns.every((row) => (row.metadata as { status: string }).status === 'completed')).toBe(true);
  });

  it('propagates cancellation to the active model and does not commit a tool result afterwards', async () => {
    const { service, execute, capability } = await setup();
    const controller = new AbortController();
    execute.mockImplementation(async (request) => { expect(request.signal.aborted).toBe(false); return await request.executeManagedTool!(tool('use_capability', { capabilityId: 'image', input: {} })); });
    capability.mockImplementation(async (...args) => { controller.abort(new Error('cancelled')); expect(args[5].aborted).toBe(true); return 'late'; });
    await expect(service.run('workspace_personal', 'execution', 'lead', 'Goal', controller.signal)).rejects.toThrow('cancelled');
    expect(db.select().from(agentCapabilityResults).all()).toHaveLength(0);
    expect(db.select().from(agentToolCalls).all()[0]?.status).toBe('cancelled');
  });

  it('freezes the reachable directory and rejects cycles before the first model call', async () => {
    const { service, execute } = await setup();
    db.update(agents).set({ collaboration: { subAgentIds: ['lead'], capabilities: [], publicModels: ['provider/model'] } }).where(and(eq(agents.id, 'researcher'), eq(agents.workspaceId, 'workspace_personal'))).run();
    await expect(service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal)).rejects.toThrow('cycle');
    expect(execute).not.toHaveBeenCalled();
  });
  it('lets the lead repair a failed research result and deliver it without repeating research', async () => {
    const { service, execute, capability } = await setup();
    const researcher = db.select().from(agents).where(eq(agents.id, 'researcher')).get()!;
    db.update(agents).set({ collaboration: { ...researcher.collaboration!, outputFormat: 'json', outputContract: ['findings'] } }).where(eq(agents.id, 'researcher')).run();
    let researchCalls = 0;
    capability.mockResolvedValue('Saved');
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('researcher')) {
        researchCalls++;
        await request.onMcpCall?.({ serverId: 'search', toolName: 'search', input: {}, result: 'Source evidence', status: 'succeeded' });
        return JSON.stringify({ evidence: ['Verified source'] });
      }
      expect(request.systemPrompt).toContain('outputContract');
      expect(request.systemPrompt).toContain('findings');
      const failed = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', task: 'Research' })));
      expect(failed.result).toMatchObject({ status: 'failed', kind: 'output_contract', partialResult: { evidence: ['Verified source'] }, toolCalls: [{ result: 'Source evidence' }] });
      const raw = JSON.parse(await request.executeManagedTool!(tool('read_result', { resultRef: failed.resultRef, path: '$.partialResult' })));
      const repaired = JSON.parse(await request.executeManagedTool!(tool('store_result', { value: { findings: raw.result.evidence } })));
      await request.executeManagedTool!(tool('use_capability', { capabilityId: 'image', input: { $result: repaired.resultRef } }));
      return 'Delivered';
    });
    expect(await service.run('workspace_personal', 'execution', 'lead', 'Deliver', new AbortController().signal)).toBe('Delivered');
    expect(researchCalls).toBe(1);
    expect(capability.mock.calls[0]?.[4]).toEqual({ findings: ['Verified source'] });
    const failedRun = db.select().from(auditLogs).all().find((row) => row.metadata.agentId === 'researcher');
    expect(failedRun?.metadata).toMatchObject({ status: 'failed', output: '{"evidence":["Verified source"]}' });
  });

  it('applies task-specific instructions, model, contract and limits without changing the template', async () => {
    const { service, execute } = await setup();
    const saved = db.select().from(agents).where(eq(agents.id, 'writer')).get()!;
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('lead')) {
        const result = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Use existing facts', overrides: { instructions: 'Repair only', model: 'provider/model', outputFormat: 'json', outputContract: ['article'], limits: { maxToolCalls: 2, maxToolRounds: 3 } } })));
        expect(result.result).toMatchObject({ status: 'completed', result: { article: 'Repaired' } });
        const denied = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'x', overrides: { model: 'unassigned/model' } })));
        expect(denied.result.status).toBe('failed');
        return 'Done';
      }
      expect(request.systemPrompt).toMatch(/^Repair only/);
      expect(request.systemPrompt).toContain('"outputContract":["article"]');
      expect(request.limits).toMatchObject({ maxToolCalls: 2, maxToolRounds: 3 });
      return '{"article":"Repaired"}';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
    expect(db.select().from(agents).where(eq(agents.id, 'writer')).get()).toEqual(saved);
  });

  it('retains streamed output and completed tool evidence when a specialist crashes', async () => {
    const { service, execute } = await setup();
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('lead')) {
        const failed = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Draft' })));
        expect(failed.result).toMatchObject({ status: 'failed', rawOutput: 'Partial draft', toolCalls: [{ commandExecutionId: 'cmd-saved' }] });
        return 'Recovered';
      }
      await request.onTextDelta?.('Partial draft');
      await request.onBuiltinTool?.({ toolName: 'bash', input: {}, commandExecutionId: 'cmd-saved', exitCode: 0, status: 'succeeded' });
      throw new Error('Provider disconnected');
    });
    expect(await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal)).toBe('Recovered');
  });

  it('lets the lead take over an assigned specialist tool without invoking its model', async () => {
    const { service, execute, executeAssignedTool } = await setup();
    execute.mockImplementation(async (request) => {
      const result = JSON.parse(await request.executeManagedTool!(tool('use_sub_agent_tool', { agentId: 'researcher', toolName: 'search', input: { query: 'missing fact' } })));
      expect(result.result.value).toBe('Existing evidence');
      const denied = JSON.parse(await request.executeManagedTool!(tool('use_sub_agent_tool', { agentId: 'unassigned' })));
      expect(denied.status).toBe('failed');
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executeAssignedTool).toHaveBeenCalledTimes(1);
    expect(executeAssignedTool.mock.calls[0]?.[1]).toMatchObject({ toolName: 'search', input: { query: 'missing fact' } });
  });

  it('isolates invalid parallel assignments and retains successful sibling results', async () => {
    const { service, execute } = await setup();
    execute.mockImplementation(async (request) => {
      if (!request.systemPrompt.startsWith('lead')) return 'Useful facts';
      const result = JSON.parse(await request.executeManagedTool!(tool('run_sub_agents', { tasks: [{ agentId: 'researcher', task: 'Facts' }, { agentId: 'unassigned', task: 'Invalid' }] })));
      expect(result.result).toMatchObject([{ status: 'completed', result: 'Useful facts' }, { status: 'failed' }]);
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
  });

  it('reserves shared tool capacity for the lead after a specialist exhausts its allocation', async () => {
    const { service, execute } = await setup();
    execute.mockImplementation(async (request) => {
      if (!request.systemPrompt.startsWith('lead')) {
        let calls = 0;
        while (!request.beforeToolCall?.(tool('test_tool', {}))) { calls++; if (calls > 128) throw new Error('Budget was not bounded'); }
        return 'Existing evidence';
      }
      await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'researcher', task: 'Research' }));
      const rejected = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'More work' })));
      expect(rejected.result.status).toBe('failed');
      expect(request.beforeToolCall?.(tool('test_tool', {}))).toBeUndefined();
      return 'Delivered with existing evidence';
    });
    expect(await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal)).toBe('Delivered with existing evidence');
  });

  it('enforces a specialist deadline while allowing the lead to recover', async () => {
    const { service, execute } = await setup();
    execute.mockImplementation(async (request) => {
      if (request.systemPrompt.startsWith('lead')) {
        const failed = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Write', overrides: { timeoutMs: 10 } })));
        expect(failed.result.status).toBe('failed');
        expect(request.signal.aborted).toBe(false);
        return 'Took over';
      }
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      return 'Unreachable';
    });
    expect(await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal)).toBe('Took over');
  });

  it('pages complete saved content and prevents reading another execution’s results', async () => {
    const { service, execute } = await setup();
    db.insert(agentExecutions).values({ id: 'other-execution', workspaceId: 'workspace_personal', agentId: 'lead', status: 'running' }).run();
    db.insert(agentCapabilityResults).values({ id: 'private-result', executionId: 'other-execution', value: 'Private' }).run();
    const longText = 'x'.repeat(13000) + 'Full ending';
    execute.mockImplementation(async (request) => {
      const saved = JSON.parse(await request.executeManagedTool!(tool('store_result', { value: longText })));
      expect(saved.result).not.toContain('Full ending');
      const page = JSON.parse(await request.executeManagedTool!(tool('read_result', { resultRef: saved.resultRef, offset: 13000, maxChars: 100 })));
      expect(page.result).toMatchObject({ text: 'Full ending', nextOffset: null });
      const denied = JSON.parse(await request.executeManagedTool!(tool('read_result', { resultRef: 'private-result' })));
      expect(denied.status).toBe('failed');
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
  });

  it('can remove template research prerequisites for a task without granting new tools', async () => {
    const { service, execute } = await setup();
    const writer = db.select().from(agents).where(eq(agents.id, 'writer')).get()!;
    db.update(agents).set({ collaboration: { ...writer.collaboration!, requiredSkillIds: ['obsolete-research'] } }).where(eq(agents.id, 'writer')).run();
    execute.mockImplementation(async (request) => {
      if (!request.systemPrompt.startsWith('lead')) {
        expect(request.systemPrompt).toContain('"requiredSkillIds":[]');
        expect(request.skills).toEqual([]);
        return 'Used existing verified facts';
      }
      const result = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'Write from provided facts', overrides: { requiredSkillIds: [], skillIds: [], builtinToolNames: [] } })));
      expect(result.result.status).toBe('completed');
      const denied = JSON.parse(await request.executeManagedTool!(tool('run_sub_agent', { agentId: 'writer', task: 'x', overrides: { builtinToolNames: ['bash'] } })));
      expect(denied.result.status).toBe('failed');
      return 'Done';
    });
    await service.run('workspace_personal', 'execution', 'lead', 'Goal', new AbortController().signal);
  });

});
