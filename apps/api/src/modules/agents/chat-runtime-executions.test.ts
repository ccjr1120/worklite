import { ChatConversationsService } from './chat-conversations.service';
import { localSkillId } from '../skills/local-skill-source';
// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agents, skills, skillFiles, agentExecutions, agentToolCalls, agentRuntimeRuns, agentRuntimeSessions, createDb, initializeDatabase, platformSkillPackageFiles, type Database } from '@worklite/db';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentsService } from './agents.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { ProjectExecutorService } from './project-executor.service';
import { WorkspaceService } from '../teams/teams.service';
import type { PreparedProjectExecution, ProjectExecutorRequest } from './project-executor.types';

const request = {} as Request;
const chat = 'agt_system_helper_chat';
let db: Database;
let root: string;
let runtime: AgentRuntimeService;
let executions: AgentExecutionsService;
afterEach(async () => {
  await runtime?.onModuleDestroy();
  if (executions) await vi.waitFor(() => expect((executions as unknown as { scheduledExecutions: Set<string> }).scheduledExecutions.size).toBe(0));
  db?.$client.close();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function setup(kind: 'codex' | 'claude', execute: (request: ProjectExecutorRequest, prepared: PreparedProjectExecution) => Promise<string>) {
  root = await mkdtemp(join(process.cwd(), '.chat-runtime-test-'));
  vi.stubEnv('WORKLITE_CHAT_RUNTIME_DIR', join(root, 'chat'));
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspace = new WorkspaceService(db);
  const resources = { reconcileWorkspaceSkills: async () => {}, agentMcpRuntimes: async () => [] };
  const configuration = new AgentsService(db, workspace, resources as never);
  vi.spyOn(configuration as never, 'gatewayProviderNames' as never).mockResolvedValue(new Map() as never);
  const adapter = { execute: vi.fn(execute), captureLaunch: async (model: string | null) => ({ executor: kind, model, commandArguments: [] }) };
  const executor = new ProjectExecutorService(adapter as never, adapter as never, resources as never);
  runtime = new AgentRuntimeService(db, executor);
  const unused = {} as never;
  const scripts = { start: vi.fn(async () => ({ id: 'command' })), wait: async () => ({ execution: { id: 'command', status: 'succeeded', exitCode: 0 }, output: 'Platform snapshot', stdout: 'Platform snapshot' }) };
  const collaboration = { list: () => db.select().from(agents).all().filter((agent) => agent.kind === 'custom').map((agent) => ({ id: agent.id, name: agent.name, responsibility: agent.responsibility })) };
  executions = new AgentExecutionsService(db, workspace, resources as never, scripts as never, unused, unused, unused, unused, { list: () => [] } as never, unused, unused, { notify: () => {} } as never, runtime, collaboration as never);
  vi.spyOn(executions as never, 'scheduleBackgroundAgentReports' as never).mockImplementation(() => {});
  const platformId = localSkillId('workspace_personal', 'worklite-platform', 'platform');
  db.insert(skills).values({ id: platformId, workspaceId: 'workspace_personal', name: 'worklite-platform', root: 'platform', directory: 'worklite-platform', instructions: '# Platform', validation: 'valid' }).run();
  db.insert(skillFiles).values(platformSkillPackageFiles().map((file) => ({ ...file, skillId: platformId }))).run();
  db.insert(skills).values({ id: 'selected', workspaceId: 'workspace_personal', name: 'selected', instructions: '# Selected', validation: 'valid' }).run();
  db.insert(skillFiles).values({ skillId: 'selected', path: 'SKILL.md', content: '# Selected\nUse the selected skill.' }).run();
  await configuration.update(request, 'personal', chat, { runtime: { kind, projectDirectory: '' }, providerId: null, model: '', skillIds: ['selected'], turnNotificationsEnabled: false });
  return { configuration, adapter, scripts, platformId };
}

async function mcp(request: ProjectExecutorRequest) {
  const server = request.mcpServers.find((server) => server.id === 'chat')!;
  const client = new Client({ name: 'engine-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.endpoint), { requestInit: { headers: { authorization: `Bearer ${server.authToken}` } } }));
  return client;
}
async function settled(id: string) {
  await vi.waitFor(() => expect((executions as unknown as { scheduledExecutions: Set<string> }).scheduledExecutions.has(id)).toBe(false));
  return executions.get(request, 'personal', chat, id);
}

describe('Chat runtime integration', () => {
  it('allows the Codex engine to select a codex/responses Provider without reverting its runtime', async () => {
    const { configuration } = await setup('codex', async () => 'Done');
    vi.spyOn(configuration as never, 'validateProvider' as never).mockResolvedValue({ name: 'codex', protocol: 'codex/responses', models: ['gpt-test'] } as never);
    const selected = await configuration.update(request, 'personal', chat, { providerId: 'proxy-provider', model: 'gpt-test', runtime: { kind: 'codex', projectDirectory: '' } });
    expect(selected).toMatchObject({ providerId: 'proxy-provider', model: 'gpt-test', runtime: { kind: 'codex' } });
  });

  it.each(['codex', 'claude'] as const)('%s accepts an answer through Chat dispatch after a native turn ends with an open MCP question', async (kind) => {
    let turns = 0;
    let ended!: () => void;
    const nativeEnded = new Promise<void>((resolve) => { ended = resolve; });
    const { adapter } = await setup(kind, async (runtimeRequest) => {
      if (++turns === 1) {
        await runtimeRequest.runtimeSession!.onSession('saved-thread');
        const client = await mcp(runtimeRequest);
        const question = client.callTool({ name: 'ask_user', arguments: { question: 'Which project?', options: ['WorkLite'] } });
        void question.catch(() => undefined);
        await vi.waitFor(() => expect(db.select().from(agentExecutions).get()?.status).toBe('waiting_for_input'));
        await client.close();
        ended();
        return 'Please confirm the project.';
      }
      expect(runtimeRequest.runtimeSession?.resumeId).toBe('saved-thread');
      expect(runtimeRequest.input).toContain('WorkLite');
      expect(runtimeRequest.input).not.toContain('Original request');
      return 'Answer received';
    });
    const { ChatDispatchService } = await import('./chat-dispatch.service');
    const dispatch = new ChatDispatchService(db, new WorkspaceService(db), executions);
    const started = await dispatch.dispatch(request, { submissionId: 'original', message: 'Original request', target: { kind: 'conversation' } });
    if (started.reference.kind !== 'conversation') throw new Error('Expected a Chat conversation');
    const id = started.reference.executionId!;
    await vi.waitFor(async () => expect((await executions.get(request, 'personal', chat, id)).pendingQuestion).toMatchObject({ question: 'Which project?' }));
    await nativeEnded;
    const waiting = await executions.get(request, 'personal', chat, id);
    const accepted = await dispatch.dispatch(request, { submissionId: 'answer', executionId: id, questionId: waiting.pendingQuestion!.id, message: 'WorkLite', target: { kind: 'conversation' } });
    expect(accepted.reference).toMatchObject({ kind: 'conversation', executionId: id });
    const result = await settled(id);
    expect(result).toMatchObject({ status: 'completed', pendingQuestion: null, error: null });
    expect(result.messages.map((message) => message.content)).toEqual(['Original request', 'WorkLite', 'Answer received']);
    expect(result.toolCalls.find((call) => call.mcpToolName === 'ask_user')).toMatchObject({ status: 'completed', output: 'WorkLite' });
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

  it.each(['codex', 'claude'] as const)('%s resumes a saved session while capturing fresh Skills and plan/question events', async (kind) => {
    let turn = 0;
    let directory = '';
    const { configuration, adapter } = await setup(kind, async (request, prepared) => {
      turn++;
      directory = request.projectDirectory;
      expect(directory).toBe(request.resourceDirectory);
      expect(directory).toContain(join(root, 'chat', 'session-'));
      expect(await readFile(join(directory, 'AGENTS.md'), 'utf8')).toBe(await readFile(join(directory, 'CLAUDE.md'), 'utf8'));
      expect(prepared.systemPrompt).toContain('delegate project code changes');
      if (turn === 1) {
        expect(await readFile(join(directory, '.agents/skills/selected/SKILL.md'), 'utf8')).toContain('Use the selected skill.');
        expect(await readFile(join(directory, '.claude/skills/selected/SKILL.md'), 'utf8')).toContain('Use the selected skill.');
        expect(request.runtimeSession?.resumeId).toBeUndefined();
      } else {
        expect(request.runtimeSession?.resumeId).toBe('saved-thread');
        await expect(stat(join(directory, '.agents/skills/selected'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(directory, '.claude/skills/selected'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await request.runtimeSession!.onSession('saved-thread');
      const client = await mcp(request);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['run_agent', 'inspect_workspace', 'update_chat', 'query_platform']));
        expect(await client.callTool({ name: 'inspect_workspace', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: expect.any(String) }] });
        const planResult = await client.callTool({ name: 'update_plan', arguments: { steps: [{ step: 'Confirm', status: 'in_progress' }, { step: 'Reply', status: 'pending' }] } });
        if (planResult.isError) throw new Error(JSON.stringify(planResult));
        if (turn === 1) {
          const result = await client.callTool({ name: 'ask_user', arguments: { question: 'Which?', options: ['A', 'B'] } });
          expect(result).toMatchObject({ content: [{ type: 'text', text: 'A' }] });
        }
      } finally { await client.close(); }
      await request.onTextDelta?.('Reply');
      return 'Reply';
    });
    const execution = await executions.create(request, 'personal', chat, { message: 'hello', projectDirectory: root });
    await vi.waitFor(async () => expect(await executions.get(request, 'personal', chat, execution.id)).toMatchObject({ status: 'waiting_for_input', error: null }));
    const waiting = await executions.get(request, 'personal', chat, execution.id);
    expect(waiting.plan).toEqual([{ step: 'Confirm', status: 'in_progress' }, { step: 'Reply', status: 'pending' }]);
    expect(waiting.pendingQuestion).toMatchObject({ question: 'Which?', options: ['A', 'B'] });
    await executions.answer(request, 'personal', chat, execution.id, { questionId: waiting.pendingQuestion!.id, answer: 'A' });
    expect((await settled(execution.id)).messages.at(-1)?.content).toBe('Reply');
    const prior = db.select().from(agentExecutions).where(eq(agentExecutions.id, execution.id)).get()!;
    await configuration.update(request, 'personal', chat, { runtime: { kind: kind === 'codex' ? 'claude' : 'codex', projectDirectory: '' }, skillIds: [], extensionPrompt: 'New turn prompt' });
    await executions.continue(request, 'personal', chat, execution.id, { message: 'next' });
    expect((await settled(execution.id)).status).toBe('completed');
    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(adapter.execute.mock.calls[1][0].launch.executor).toBe(kind);
    expect(adapter.execute.mock.calls[1][0].systemPrompt).toContain('New turn prompt');
    expect(prior.capabilitySnapshot!.skills.filter((skill) => skill.id === 'selected').map((skill) => skill.id)).toEqual(['selected']);
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, execution.id)).get()!.capabilitySnapshot!.skills.filter((skill) => skill.id === 'selected')).toEqual([]);
    expect(db.select().from(agentRuntimeRuns).all().map((run) => run.status)).toEqual(['completed', 'completed']);
    expect(db.select().from(agentToolCalls).all().filter((call) => call.mcpToolName === 'ask_user')).toMatchObject([{ status: 'completed', output: 'A' }]);
    expect(db.select().from(agentRuntimeSessions).get()?.resourceDirectory).toBe(directory);
    expect(db.select().from(agents).where(eq(agents.id, chat)).get()?.runtime.kind).not.toBe(kind);
  });
  it('summarizes an engine conversation and starts its next native context from that summary', async () => {
    let nativeTurns = 0;
    const { adapter } = await setup('codex', async (request) => {
      if (!request.runtimeSession) {
        expect(request.input).toContain('Original reply');
        return 'Keep this summary';
      }
      nativeTurns++;
      expect(request.runtimeSession.resumeId).toBeUndefined();
      await request.runtimeSession.onSession(`thread-${nativeTurns}`);
      if (nativeTurns === 2) expect(request.input).toContain('Keep this summary');
      return nativeTurns === 1 ? 'Original reply' : 'Continued from summary';
    });
    const execution = await executions.create(request, 'personal', chat, { message: 'Original user message' });
    await settled(execution.id);
    const conversations = new ChatConversationsService(db, new WorkspaceService(db), executions, {} as never, runtime);
    const summarized = await conversations.summarize(request, execution.id);
    expect(summarized.messages.at(-1)).toMatchObject({ kind: 'summary_divider', content: 'Keep this summary' });
    expect(db.select().from(agentRuntimeSessions).get()?.externalSessionId).toBeNull();
    await executions.continue(request, 'personal', chat, execution.id, { message: 'Continue' });
    expect((await settled(execution.id)).messages.at(-1)?.content).toBe('Continued from summary');
    expect(adapter.execute).toHaveBeenCalledTimes(3);
  });

  it('keeps the existing task card and aggregate status after an engine dispatches an Agent', async () => {
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    const { adapter } = await setup('codex', async (request) => {
      if (request.owner === 'agent') {
        started();
        return new Promise<string>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      }
      const client = await mcp(request);
      try {
        const result = await client.callTool({ name: 'run_agent', arguments: { agentId: 'worker', task: 'Implement the user request', mode: 'new', projectDirectory: root } });
        if (result.isError) throw new Error(JSON.stringify(result));
      } finally { await client.close(); }
      return ''; // The dispatch card is the acknowledgement.
    });
    db.insert(agents).values({ id: 'worker', workspaceId: 'workspace_personal', name: 'Worker', responsibility: 'Coding', model: '', runtime: { kind: 'codex', projectDirectory: root } }).run();
    const chatExecution = await executions.create(request, 'personal', chat, { message: 'Implement the user request' });
    await childStarted;
    const view = await settled(chatExecution.id);
    expect(view).toMatchObject({ status: 'completed', conversationStatus: 'running' });
    expect(view.messages.filter((message) => message.role === 'assistant')).toEqual([]);
    const dispatch = db.select().from(agentToolCalls).where(eq(agentToolCalls.executionId, chatExecution.id)).get()!;
    expect(dispatch).toMatchObject({ status: 'completed', mcpToolName: 'run_agent', input: { __agentName: 'Worker', __backgroundExecutionId: expect.any(String) } });
    const childId = (dispatch.input as { __backgroundExecutionId: string }).__backgroundExecutionId;
    await executions.cancel(request, 'personal', 'worker', childId);
    expect((await executions.get(request, 'personal', chat, chatExecution.id)).conversationStatus).toBe('completed');
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

});
