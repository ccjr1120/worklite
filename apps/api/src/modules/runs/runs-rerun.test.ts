import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { RunView, WorkflowNodeRunStatus } from '@worklite/contracts';
import {
  artifacts,
  auditLogs,
  createDb,
  initializeDatabase,
  workflowDrafts,
  workflowNodeRuns,
  workflowRunEvents,
  workflowRuns,
  workflowVersions,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowNode,
} from '@worklite/db';
import { eq } from 'drizzle-orm';
import type { WorkspaceService } from '../teams/teams.service';
import type { AgentExecutionsService } from '../agents/agent-executions.service';
import type { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import type { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import type { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { getArtifactDetail, listArtifacts } from '../artifacts/artifacts-query';
import { RunsService } from './runs.service';

const WORKSPACE_ID = 'workspace_personal';
const RUN_ID = 'run_rerun';
const request = {} as Request;

let db: Database;
let service: RunsService;
let executeWorkflowAgent: ReturnType<typeof vi.fn>;
let assertPublicAgentModel: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  db = createDb(':memory:');
  await initializeDatabase(db);
  executeWorkflowAgent = vi.fn().mockResolvedValue('new output');
  assertPublicAgentModel = vi.fn().mockResolvedValue(undefined);
  const agentExecutions = {
    assertPublicAgentModel,
    executeWorkflowAgent,
    resolveWorkflowSkillIds: vi.fn(async (_workspaceId: string, ids: string[]) => ids),
  } as unknown as AgentExecutionsService;
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  service = new RunsService(
    db,
    workspaces,
    agentExecutions,
    { subscribe: () => () => undefined } as unknown as WechatOfficialAccountService,
    {} as PortkeyGatewayService,
    {} as ArtifactStorageService,
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  db.$client.close();
});

function node(id: string, type: string, config: Record<string, unknown> = {}): StoredWorkflowNode {
  return { id, position: { x: 0, y: 0 }, type, typeVersion: '1', config, errorPolicy: 'stop' };
}

function agentNode(model: string | string[] = 'Original/model'): StoredWorkflowNode {
  return node('agent', 'worklite/agent', { model, systemPrompt: 'Write a result', skillIds: [], mcpServerIds: [], outputFormat: 'text' });
}

function artifactNode(): StoredWorkflowNode {
  return node('artifact', 'worklite/artifact', { name: 'result', format: 'text' });
}

function definition(nodes: StoredWorkflowNode[], edges: StoredWorkflowDefinition['edges'] = []): StoredWorkflowDefinition {
  return { schemaVersion: 4, input: {}, defaults: { errorPolicy: 'stop' }, nodes, edges };
}

function agentArtifactDefinition(model: string | string[] = 'Original/model'): StoredWorkflowDefinition {
  return definition(
    [agentNode(model), artifactNode()],
    [{ id: 'edge_agent_artifact', sourceNodeId: 'agent', sourcePort: 'output', targetNodeId: 'artifact', targetPort: 'data' }],
  );
}

function seedFixture(options: {
  workflowDefinition?: StoredWorkflowDefinition;
  runStatus?: RunView['status'];
  targetStatus?: WorkflowNodeRunStatus;
  executionState?: typeof workflowRuns.$inferInsert.executionState;
} = {}) {
  const workflowDefinition = options.workflowDefinition ?? agentArtifactDefinition();
  const runStatus = options.runStatus ?? 'succeeded';
  const targetStatus = options.targetStatus ?? 'succeeded';
  const target = workflowDefinition.nodes[0]!;
  const downstream = workflowDefinition.nodes[1];
  const targetInput = { context: { topic: 'preserved' } };
  const oldArtifactOutput = { type: 'artifact', artifactId: 'art_old', name: 'result', format: 'text' };
  const terminalOutput = downstream ? oldArtifactOutput : 'old output';
  db.insert(workflows).values({ id: 'wf_rerun', workspaceId: WORKSPACE_ID, name: 'Rerun workflow', state: 'published' }).run();
  db.insert(workflowVersions).values({
    id: 'wfv_rerun', workspaceId: WORKSPACE_ID, workflowId: 'wf_rerun', version: 1, published: true,
    schemaVersion: 4, nodes: workflowDefinition.nodes, definition: workflowDefinition,
  }).run();
  db.insert(workflowDrafts).values({ id: 'wfd_rerun', workspaceId: WORKSPACE_ID, workflowId: 'wf_rerun', definition: workflowDefinition }).run();
  db.insert(workflowRuns).values({
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: 'wf_rerun',
    workflowVersionId: 'wfv_rerun',
    status: runStatus,
    input: { topic: 'preserved' },
    result: { [downstream?.id ?? target.id]: terminalOutput },
    executionState: options.executionState === undefined ? {
      ready: [],
      pendingInputs: {},
      edgeTraversals: Object.fromEntries(workflowDefinition.edges.map((edge) => [edge.id, 1])),
      latestOutputs: { [target.id]: 'old output', ...(downstream ? { [downstream.id]: oldArtifactOutput } : {}) },
      terminalOutputs: { [downstream?.id ?? target.id]: terminalOutput },
      nextPosition: downstream ? 2 : 1,
      ...(runStatus === 'failed' ? { active: { nodeId: target.id, input: targetInput, nodeRunId: 'nr_target', position: 1 } } : {}),
    } : options.executionState,
    currentNodeId: null,
    finishedAt: ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(runStatus) ? new Date() : null,
  }).run();
  db.insert(workflowNodeRuns).values({
    id: 'nr_target', runId: RUN_ID, workspaceId: WORKSPACE_ID, nodeId: target.id, position: 1,
    type: target.type, typeVersion: target.typeVersion, status: targetStatus, input: targetInput,
    output: targetStatus === 'failed' ? null : 'old output', error: targetStatus === 'failed' ? 'old failure' : null,
    finishedAt: new Date(), supersededByNodeRunId: targetStatus === 'superseded' ? 'nr_replacement' : null,
  }).run();
  if (downstream) {
    db.insert(workflowNodeRuns).values({
      id: 'nr_downstream', runId: RUN_ID, workspaceId: WORKSPACE_ID, nodeId: downstream.id, position: 2,
      type: downstream.type, typeVersion: downstream.typeVersion, status: 'succeeded', input: { data: 'old output' },
      output: oldArtifactOutput, artifactIds: downstream.type === 'worklite/artifact' ? ['art_old'] : [], finishedAt: new Date(),
    }).run();
    if (downstream.type === 'worklite/artifact') {
      db.insert(artifacts).values({
        id: 'art_old', workspaceId: WORKSPACE_ID, workflowId: 'wf_rerun', runId: RUN_ID,
        name: 'result', format: 'text', content: 'old output', size: '10 B',
      }).run();
    }
  }
  return workflowDefinition;
}

async function drainExecution() {
  await (service as unknown as { execute(runId: string): Promise<void> }).execute(RUN_ID);
}

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getResponse()).toMatchObject({ code });
}

describe('RunsService node rerun', () => {
  it('creates an evidenced attempt with a one-off model and supersedes downstream records and artifacts', async () => {
    const originalDefinition = seedFixture();
    const accepted = await service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { modelOverride: 'OpenAI/gpt-new' });
    const newTarget = accepted.nodeRuns!.find((row) => row.rerunEvidence?.sourceNodeRunId === 'nr_target')!;
    expect(accepted.status).toBe('queued');
    expect(newTarget).toMatchObject({
      nodeId: 'agent', status: 'queued', input: { context: { topic: 'preserved' } }, retryCount: 0,
      rerunEvidence: {
        sourceNodeRunId: 'nr_target', requestedBy: 'You', modelOverride: 'OpenAI/gpt-new',
        supersededNodeRunIds: ['nr_target', 'nr_downstream'], sideEffectsConfirmed: false,
      },
    });
    expect(accepted.nodeRuns!.find((row) => row.id === 'nr_target')).toMatchObject({ status: 'superseded', supersededByNodeRunId: newTarget.id, output: 'old output', rerunnable: false });
    expect(accepted.nodeRuns!.find((row) => row.id === 'nr_downstream')).toMatchObject({ status: 'superseded', supersededByNodeRunId: newTarget.id });
    expect(accepted.artifacts!.find((artifact) => artifact.id === 'art_old')).toMatchObject({ content: 'old output', supersededByNodeRunId: newTarget.id });
    expect(assertPublicAgentModel).toHaveBeenCalledWith('OpenAI/gpt-new');

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'workflow.node_rerun'));
    expect(audit).toMatchObject({ resource: RUN_ID, actorId: null, metadata: { sourceNodeRunId: 'nr_target', newNodeRunId: newTarget.id, modelOverride: 'OpenAI/gpt-new', supersededNodeRunIds: ['nr_target', 'nr_downstream'] } });
    const rerunEvents = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.type, 'node.rerun'));
    expect(rerunEvents).toHaveLength(1);
    expect(rerunEvents[0]!.payload).toMatchObject({ sourceNodeRunId: 'nr_target', newNodeRunId: newTarget.id, nodeId: 'agent', requestedBy: 'You', modelOverride: 'OpenAI/gpt-new' });

    await drainExecution();
    expect(executeWorkflowAgent).toHaveBeenCalledOnce();
    expect(executeWorkflowAgent.mock.calls[0]![1]).toBe('OpenAI/gpt-new');
    expect(executeWorkflowAgent.mock.calls[0]![2]).toEqual({ topic: 'preserved' });
    const finished = await service.get(request, 'personal', RUN_ID);
    expect(finished.status).toBe('succeeded');
    expect(finished.nodeRuns!.map((row) => [row.id, row.status])).toEqual([
      ['nr_target', 'superseded'], ['nr_downstream', 'superseded'], [newTarget.id, 'succeeded'], [expect.any(String), 'succeeded'],
    ]);
    expect(finished.nodeRuns!.find((row) => row.id === newTarget.id)).toMatchObject({ input: { context: { topic: 'preserved' } }, output: 'new output', rerunnable: true });
    const newArtifact = finished.artifacts!.find((artifact) => artifact.id !== 'art_old')!;
    expect(newArtifact).toMatchObject({ content: 'new output', supersededAt: null, supersededByNodeRunId: null });
    expect(finished.result).toEqual({ artifact: { type: 'artifact', artifactId: newArtifact.id, name: 'result', format: 'text' } });

    const oldArtifact = await db.select().from(artifacts).where(eq(artifacts.id, 'art_old'));
    expect(oldArtifact[0]).toMatchObject({ content: 'old output', supersededByNodeRunId: newTarget.id });
    const listed = await listArtifacts(db, WORKSPACE_ID, 'personal', { pageSize: 10 });
    expect(listed.items.find((artifact) => artifact.id === 'art_old')).toMatchObject({ supersededByNodeRunId: newTarget.id, supersededAt: expect.any(String) });
    expect(listed.items.find((artifact) => artifact.id === newArtifact.id)).toMatchObject({ supersededByNodeRunId: null, supersededAt: null });
    const detail = await getArtifactDetail(db, WORKSPACE_ID, 'personal', 'art_old');
    expect(detail).toMatchObject({ content: 'old output', supersededByNodeRunId: newTarget.id, supersededAt: expect.any(String) });

    const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, 'wfv_rerun'));
    const [draft] = await db.select().from(workflowDrafts).where(eq(workflowDrafts.id, 'wfd_rerun'));
    expect(version.definition).toEqual(originalDefinition);
    expect(draft.definition).toEqual(originalDefinition);
    expect(await db.select().from(workflowVersions)).toHaveLength(1);
    const setupEvent = (await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.type, 'node.activity')))
      .find((event) => (event.payload as { nodeRunId?: string; phase?: string }).nodeRunId === newTarget.id && (event.payload as { phase?: string }).phase === 'node.setup');
    expect(setupEvent?.payload).toMatchObject({ detail: { config: { model: 'OpenAI/gpt-new' } } });
  });

  it('keeps an Agent fallback list when no override is supplied', async () => {
    seedFixture({ workflowDefinition: definition([agentNode(['First/model', 'Second/model'])]) });
    await service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {});
    await drainExecution();
    expect(executeWorkflowAgent.mock.calls[0]![1]).toEqual(['First/model', 'Second/model']);
    expect(assertPublicAgentModel).not.toHaveBeenCalled();
  });

  it.each(['failed', 'paused'] as const)('accepts a rerun from a %s Run', async (runStatus) => {
    seedFixture({ runStatus, targetStatus: runStatus === 'failed' ? 'failed' : 'succeeded' });
    const result = await service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {});
    expect(result.status).toBe('queued');
    expect(result.nodeRuns!.some((row) => row.rerunEvidence?.sourceNodeRunId === 'nr_target')).toBe(true);
  });

  it.each(['queued', 'running', 'waiting_for_input', 'cancelled', 'timed_out'] as const)('rejects a %s Run', async (runStatus) => {
    seedFixture({ runStatus });
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {}), 'RUN_NODE_RERUN_NOT_ALLOWED');
    expect(await db.select().from(workflowNodeRuns)).toHaveLength(2);
  });

  it.each(['queued', 'running', 'waiting_for_input', 'cancelled', 'superseded'] as const)('rejects a %s node attempt', async (targetStatus) => {
    seedFixture({ targetStatus });
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {}), 'RUN_NODE_RERUN_NODE_NOT_ELIGIBLE');
  });

  it('rejects model overrides for non-Agent nodes and malformed requests', async () => {
    seedFixture({ workflowDefinition: definition([artifactNode()]) });
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { modelOverride: 'OpenAI/gpt-new' }), 'RUN_NODE_RERUN_INVALID_MODEL');
    expect(assertPublicAgentModel).not.toHaveBeenCalled();
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { modelOverride: '   ' }), 'RUN_NODE_RERUN_INVALID_MODEL');
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { unexpected: true } as never), 'RUN_NODE_RERUN_INVALID_REQUEST');
  });

  it('preserves model resource validation failures without writing an attempt', async () => {
    seedFixture();
    const failure = new NotFoundException('Model provider OpenAI was not found.');
    assertPublicAgentModel.mockRejectedValueOnce(failure);
    await expect(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { modelOverride: 'OpenAI/missing' })).rejects.toBe(failure);
    expect(await db.select().from(workflowNodeRuns)).toHaveLength(2);
  });

  it('adds a stable rerun code to protocol and model configuration errors', async () => {
    seedFixture();
    assertPublicAgentModel.mockRejectedValueOnce(new BadRequestException('Model provider TypeSafe does not support Agent execution.'));
    const promise = service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { modelOverride: 'TypeSafe/questions' });
    await expectErrorCode(promise, 'RUN_NODE_RERUN_INVALID_MODEL');
    await expect(promise).rejects.toThrow('Model provider TypeSafe does not support Agent execution.');
    expect(await db.select().from(workflowNodeRuns)).toHaveLength(2);
  });

  it('requires confirmation for a downstream WeChat publish side effect', async () => {
    const publish = node('publish', 'wechat-official-account/publish', { mode: 'draft' });
    seedFixture({ workflowDefinition: definition(
      [agentNode(), publish],
      [{ id: 'edge_agent_publish', sourceNodeId: 'agent', sourcePort: 'output', targetNodeId: 'publish', targetPort: 'article' }],
    ) });
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {}), 'RUN_NODE_RERUN_SIDE_EFFECT_CONFIRMATION_REQUIRED');
    expect(await db.select().from(workflowNodeRuns)).toHaveLength(2);
    const result = await service.rerunNode(request, 'personal', RUN_ID, 'nr_target', { confirmSideEffects: true });
    expect(result.nodeRuns!.find((row) => row.rerunEvidence)?.rerunEvidence).toMatchObject({ sideEffectsConfirmed: true, supersededNodeRunIds: ['nr_target', 'nr_downstream'] });
  });

  it('rejects a missing scheduler state', async () => {
    seedFixture({ executionState: null });
    await expectErrorCode(service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {}), 'RUN_NODE_RERUN_STATE_UNAVAILABLE');
  });

  it('allows only one concurrent rerun for a Run', async () => {
    seedFixture();
    const results = await Promise.allSettled([
      service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {}),
      service.rerunNode(request, 'personal', RUN_ID, 'nr_target', {}),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect((rejected.reason as ConflictException).getResponse()).toMatchObject({ code: 'RUN_NODE_RERUN_NOT_ALLOWED' });
    expect(await db.select().from(workflowNodeRuns)).toHaveLength(3);
  });

  it('preserves the legacy in-place failed-node retry behavior', async () => {
    seedFixture({ workflowDefinition: definition([agentNode()]), runStatus: 'failed', targetStatus: 'failed' });
    const result = await service.retryNode(request, 'personal', RUN_ID, 'nr_target');
    expect(result.nodeRuns).toHaveLength(1);
    expect(result.nodeRuns![0]).toMatchObject({ id: 'nr_target', status: 'queued', retryCount: 1, rerunEvidence: null, supersededByNodeRunId: null });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, 'workflow.node_rerun'))).toHaveLength(0);
  });
});
