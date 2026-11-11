// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { agents, agentExecutions, agentExecutionColumns, agentToolCalls, createDb, initializeDatabase, type Database } from '@worklite/db';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentsService } from './agents.service';
import { ChatConversationsService } from './chat-conversations.service';
import { WorkspaceService } from '../teams/teams.service';

const gateway = vi.hoisted(() => ({ generateAgentStep: vi.fn(), streamText: vi.fn() }));
vi.mock('@worklite/model-gateway', async (original) => ({
  ...(await original<typeof import('@worklite/model-gateway')>()), createModelGateway: () => gateway,
}));
const request = {} as Request;
const chat = 'agt_system_helper_chat';
let db: Database;
let executions: AgentExecutionsService;
afterEach(async () => {
  if (executions) await vi.waitFor(() => expect((executions as unknown as { scheduledExecutions: Map<string, unknown> }).scheduledExecutions.size).toBe(0));
  db?.$client.close();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const reply = (text: string) => ({ text, toolCalls: [], responseMessages: [{ role: 'assistant', content: [{ type: 'text', text }] }], contextDropped: 0 });
async function setup() {
  db = createDb(':memory:');
  await initializeDatabase(db);
  db.update(agents).set({ providerId: 'provider', model: 'model' }).where(eq(agents.id, chat)).run();
  const workspace = new WorkspaceService(db);
  const resources = { reconcileWorkspaceSkills: async () => {}, providerRuntime: async () => ({ provider: { id: 'provider', adapter: 'openai' }, model: 'model', protocol: 'openai/responses' }) };
  const runtime = { executeTurn: vi.fn(), waitForStop: vi.fn() };
  const unused = {} as never;
  executions = new AgentExecutionsService(db, workspace, resources as never, unused, { discover: async () => [] } as never, unused, unused, unused,
    { list: () => [], activeForExecution: () => [], subscriptionsFor: () => [] } as never, { describe: () => undefined, load: () => undefined } as never, unused,
    { notify: () => {} } as never, runtime as never);
  return { runtime, workspace, resources };
}
async function settled(id: string) {
  await vi.waitFor(() => expect((executions as unknown as { scheduledExecutions: Map<string, unknown> }).scheduledExecutions.has(id)).toBe(false));
  return executions.get(request, 'personal', chat, id);
}

describe('native-only Chat', () => {
  it.each(['claude', 'codex'] as const)('rejects %s Chat configuration without a partial write', async (kind) => {
    const { workspace, resources } = await setup();
    const service = new AgentsService(db, workspace, resources as never);
    await expect(service.update(request, 'personal', chat, { runtime: { kind, projectDirectory: '' }, extensionPrompt: 'Must not save' })).rejects.toThrow('Chat only supports the native runtime.');
    expect(db.select().from(agents).where(eq(agents.id, chat)).get()?.runtime).toEqual({ kind: 'native' });
  });

  it.each(['claude', 'codex'] as const)('runs old %s Chat snapshots through native and captures native on continuation', async (kind) => {
    const { runtime } = await setup();
    gateway.generateAgentStep.mockResolvedValue(reply('Native reply'));
    const first = await executions.create(request, 'personal', chat, { message: 'Hello' });
    await settled(first.id);
    const execution = db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, first.id)).get()!;
    db.update(agentExecutions).set({ status: 'running', capabilitySnapshot: { ...execution.capabilitySnapshot!, agent: { ...execution.capabilitySnapshot!.agent, runtime: { kind, projectDirectory: '' } } } }).where(eq(agentExecutions.id, first.id)).run();
    await (executions as unknown as { advance(req: Request, slug: string, id: string): Promise<unknown> }).advance(request, 'personal', first.id);
    expect(runtime.executeTurn).not.toHaveBeenCalled();
    await executions.continue(request, 'personal', chat, first.id, { message: 'Continue' });
    expect(await settled(first.id)).toMatchObject({ status: 'completed' });
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, first.id)).get()?.capabilitySnapshot?.agent.runtime).toEqual({ kind: 'native' });
    expect(gateway.generateAgentStep).toHaveBeenCalledTimes(3);
  });

  it('continues the native loop after the user answers a question', async () => {
    const { runtime } = await setup();
    const call = { type: 'tool-call', toolCallId: 'question', toolName: 'ask_user', input: { question: 'Which project?', options: ['WorkLite'] } };
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [{ role: 'assistant', content: [call] }], toolCalls: [call], contextDropped: 0 }).mockResolvedValueOnce(reply('Answer received'));
    const first = await executions.create(request, 'personal', chat, { message: 'Start' });
    const waiting = await settled(first.id);
    expect(waiting.status).toBe('waiting_for_input');
    await executions.answer(request, 'personal', chat, first.id, { questionId: waiting.pendingQuestion!.id, answer: 'WorkLite' });
    await vi.waitFor(async () => expect((await executions.get(request, 'personal', chat, first.id)).status).toBe('completed'));
    expect(db.select().from(agentToolCalls).get()).toMatchObject({ mcpToolName: 'ask_user', status: 'completed', output: 'WorkLite', resultAppended: true });
    expect(runtime.executeTurn).not.toHaveBeenCalled();
  });

  it('summarizes legacy engine history through the configured Gateway model', async () => {
    const { workspace, resources, runtime } = await setup();
    gateway.generateAgentStep.mockResolvedValue(reply('Original reply'));
    const first = await executions.create(request, 'personal', chat, { message: 'Hello' });
    await settled(first.id);
    gateway.streamText.mockReturnValue({ result: Promise.resolve({ text: 'Retained summary' }) });
    const conversations = new ChatConversationsService(db, workspace, executions, resources as never);
    const result = await conversations.summarize(request, first.id);
    expect(result.messages.at(-1)).toMatchObject({ kind: 'summary_divider', content: 'Retained summary' });
    expect(gateway.streamText).toHaveBeenCalledOnce();
    expect(runtime.executeTurn).not.toHaveBeenCalled();
  });
});
