import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentExecutions, agentToolCalls, createDb, initializeDatabase, type Database } from '@worklite/db';
import { AgentExecutionsService } from './agent-executions.service';
import type { ChatProjectTasksService } from './chat-project-tasks.service';
import type { HostNotificationsService } from '../notifications/host-notifications.service';

// A Chat turn that has used its whole tool budget still ends with a reply: the next model step
// runs without new tool calls instead of the turn failing with "maximum tool rounds".
const gateway = vi.hoisted(() => ({ generateAgentStep: vi.fn() }));
vi.mock('@worklite/model-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@worklite/model-gateway')>()),
  createModelGateway: () => ({ generateAgentStep: gateway.generateAgentStep }),
}));

const WORKSPACE_ID = 'workspace_personal';
const CHAT_AGENT_ID = 'agt_system_helper_chat';
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
  gateway.generateAgentStep.mockReset();
});

async function setup(priorToolCalls: number) {
  const db = createDb(':memory:');
  dbs.push(db);
  await initializeDatabase(db);
  const calls = Array.from({ length: priorToolCalls }, (_, index) => `call_${index}`);
  db.insert(agentExecutions).values({
    id: 'aex_budget', workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, status: 'running', phase: 'model',
    capabilitySnapshot: { agent: { id: CHAT_AGENT_ID, providerId: 'provider', model: 'model', systemPrompt: 'You are Chat.' }, skills: [] } as never,
    modelMessages: [
      { role: 'user', content: 'Look into how Claude Code and Codex handle conditional tasks.' },
      ...calls.flatMap((toolCallId) => [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'run_host_command', input: {} }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'run_host_command', output: { type: 'text', value: 'ok' } }] },
      ]),
    ] as never,
  }).run();
  for (const toolCallId of calls) {
    db.insert(agentToolCalls).values({
      id: `acall_${toolCallId}`, executionId: 'aex_budget', workspaceId: WORKSPACE_ID, agentId: CHAT_AGENT_ID, toolCallId,
      toolName: 'builtin', mcpToolName: 'run_host_command', workingDirectory: '/tmp', status: 'completed', resultAppended: true,
    }).run();
  }
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal' }) };
  const resources = { providerRuntime: async () => ({ provider: { id: 'provider', adapter: 'openai', apiKey: 'key' }, model: 'model', protocol: 'openai/responses' }) };
  const projectTasks = { subscriptionsFor: () => [], list: () => [] } as unknown as ChatProjectTasksService;
  const attachments = { describe: () => undefined, load: () => undefined };
  const hostNotifications = { notify: () => {} } as unknown as HostNotificationsService;
  const mcpRuntime = { discover: async () => [] };
  const unused = {} as never;
  const service = new AgentExecutionsService(db, workspaces as never, resources as never, unused, mcpRuntime as never, unused, unused, unused, unused, projectTasks, attachments as never, unused, hostNotifications);
  return { db, service };
}

async function advance(service: AgentExecutionsService) {
  return (service as unknown as { advance(request: unknown, slug: string, id: string): Promise<{ status: string; error: string | null }> })
    .advance({}, 'personal', 'aex_budget');
}

describe('Chat tool budget', () => {
  it('answers without tools once the budget is spent instead of failing the turn', async () => {
    const { service } = await setup(24);
    gateway.generateAgentStep.mockResolvedValueOnce({ text: 'Here is what I found so far.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Here is what I found so far.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 });

    const view = await advance(service);

    expect(view.status).toBe('completed');
    const request = gateway.generateAgentStep.mock.calls[0]![0] as { toolsDisabled?: boolean; messages: Array<{ role: string; content: unknown }> };
    expect(request.toolsDisabled).toBe(true);
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('tool budget for this turn is exhausted') });
  });

  it('keeps tools available while the turn is under budget', async () => {
    const { service } = await setup(3);
    gateway.generateAgentStep.mockResolvedValueOnce({ text: 'Done.', responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }], toolCalls: [], finishReason: 'stop', contextDropped: 0 });

    await advance(service);

    const request = gateway.generateAgentStep.mock.calls[0]![0] as { toolsDisabled?: boolean };
    expect(request.toolsDisabled).toBe(false);
  });

  it('still fails the turn when the model ignores the budget and asks for another tool', async () => {
    const { db, service } = await setup(24);
    gateway.generateAgentStep.mockResolvedValueOnce({ text: '', responseMessages: [], toolCalls: [{ toolCallId: 'call_more', toolName: 'run_host_command', input: {} }], finishReason: 'tool-calls', contextDropped: 0 });

    await advance(service);

    const [row] = db.select().from(agentExecutions).all();
    expect(row?.status).toBe('failed');
  });
});
