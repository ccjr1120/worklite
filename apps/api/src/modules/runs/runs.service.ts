import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { ArtifactView, CreateRunRequest, RunProgressEvent, RunView, WorkflowNodeRunView, WorkflowPendingActionView } from '@worklite/contracts';
import {
  artifacts,
  workflowNodeRuns,
  workflowPendingActions,
  workflowRunEvents,
  workflowRuns,
  workflowVersions,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowExecutionState,
  type StoredWorkflowNode,
} from '@worklite/db';
import { commitWorkflowInvocation, createWorkflowSchedulerState, NodeTypeRegistry, resolveWorkflowNodeCapability, takeNextWorkflowInvocation, workflowRunResult, type NodeExecutionRequest, type PendingNodeExecutionResult, type WorkflowSchedulerState } from '@worklite/workflow-engine';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from '../agents/agent-executions.service';
import { WechatOfficialAccountService } from '../plugins/wechat-official-account.service';
import { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';

type RunListener = (event: RunProgressEvent) => void;

class RunCancelledError extends Error {
  constructor() {
    super('Workflow run cancelled.');
    this.name = 'RunCancelledError';
  }
}

@Injectable()
export class RunsService {
  private readonly registry = new NodeTypeRegistry();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly listeners = new Set<RunListener>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly pendingCompletions = new Set<string>();
  private completionFlush: Promise<void> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly agentExecutions: AgentExecutionsService,
    private readonly wechatOfficialAccount: WechatOfficialAccountService,
    private readonly gateway: PortkeyGatewayService,
  ) {
    const capability = (id: string, version = '1') => {
      const value = resolveWorkflowNodeCapability(id, version);
      if (!value) throw new Error(`Workflow node capability is unavailable: ${id}@${version}`);
      return value;
    };
    this.registry.register({
      ...capability('worklite/input'),
      execute: async ({ context }) => ({ output: context.variables.workflowInput }),
    });
    this.registry.register({
      ...capability('worklite/timer'),
      execute: async ({ input }) => ({ output: { trigger: 'timer', value: input ?? null } }),
    });
    this.registry.register({
      ...capability('worklite/dashboard'),
      execute: async ({ input }) => ({ output: (input as { data?: unknown } | null | undefined)?.data ?? null }),
    });
    this.registry.register({
      ...capability('worklite/artifact'),
      execute: async ({ input }) => ({ output: (input as { data?: unknown } | null | undefined)?.data ?? null }),
    });
    this.registry.register({
      ...capability('worklite/artifact-query'),
      execute: async ({ input, config, context }) => {
        const settings = asRecord(config);
        const name = settings?.name as string;
        const titleField = settings?.titleField as string;
        const descriptionFields = settings?.descriptionFields as string[];
        const rows = await this.db.select({ id: artifacts.id, content: artifacts.content, createdAt: artifacts.createdAt })
          .from(artifacts)
          .where(and(eq(artifacts.workspaceId, context.workspaceId), eq(artifacts.name, name), eq(artifacts.type, 'json')))
          .orderBy(desc(artifacts.createdAt), desc(artifacts.id));
        const candidates: Array<{ artifactId: string; title: string; description: string; createdAt: string | null }> = [];
        for (const row of rows) {
          let record: Record<string, unknown> | null;
          try {
            record = asRecord(JSON.parse(row.content));
          } catch {
            continue;
          }
          const titleValue = record?.[titleField];
          const title = typeof titleValue === 'string' ? titleValue.trim() : '';
          const description = descriptionFields.map((field) => {
            const value = record?.[field];
            return typeof value === 'string' ? value.trim() : '';
          }).filter(Boolean).join(' ');
          if (title && description) candidates.push({ artifactId: row.id, title, description, createdAt: row.createdAt?.toISOString() ?? null });
        }
        return { output: { request: asRecord(input)?.request, candidates } };
      },
    });
    this.registry.register({
      ...capability('worklite/agent'),
      execute: async (request) => {
        const config = asRecord(request.config);
        const inputs = asRecord(request.input);
        if (!config || typeof config.model !== 'string' || typeof config.systemPrompt !== 'string') throw new Error('Agent node requires a model and system prompt.');
        if (!Array.isArray(config.skillIds) || config.skillIds.some((id) => typeof id !== 'string')) throw new Error('Agent node requires valid Skill identifiers.');
        if (!Array.isArray(config.mcpServerIds) || config.mcpServerIds.some((id) => typeof id !== 'string')) throw new Error('Agent node requires valid MCP server identifiers.');
        const context = inputs && Object.prototype.hasOwnProperty.call(inputs, 'context') ? inputs.context : request.context.variables.workflowInput;
        const response = await this.agentExecutions.executeWorkflowAgent(request.context.workspaceId, config.model, context, config.systemPrompt, config.skillIds as string[], config.mcpServerIds as string[], request.signal, (delta) => { void this.publish(request.context.workflowRunId, 'node.delta', { nodeId: request.context.nodeId, delta }); }, config.outputFormat === 'json');
        const output = config.outputFormat === 'json' ? parseWorkflowAgentJson(response) : response;
        return { output };
      },
    });
    this.registry.register({
      ...capability('worklite/image'),
      execute: async (request) => {
        const config = asRecord(request.config);
        const input = asRecord(request.input);
        const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
        if (!config || config.model !== 'codex/gpt-image-2') throw new Error('Image node requires the codex/gpt-image-2 model.');
        if (!prompt.trim()) throw new Error('Image node requires a prompt.');
        if (typeof config.n !== 'number' || !Number.isInteger(config.n) || config.n < 1) throw new Error('Image node image count must be a positive integer.');
        if (config.background !== 'opaque' && config.background !== 'transparent') throw new Error('Image node background is invalid.');
        if (config.quality !== 'low' && config.quality !== 'medium' && config.quality !== 'high') throw new Error('Image node quality is invalid.');
        if (config.size !== '1024x1024' && config.size !== '1536x1024' && config.size !== '1024x1536') throw new Error('Image node size is invalid.');
        const output = await this.gateway.generateImage({
          prompt,
          model: config.model,
          n: config.n,
          background: config.background,
          quality: config.quality,
          size: config.size,
          signal: request.signal,
        });
        return { output };
      },
    });
    this.registry.register({
      ...capability('wechat-official-account/publish', '1'),
      execute: (request) => this.wechatOfficialAccount.execute(request, '1'),
    });
    this.registry.register({
      ...capability('wechat-official-account/publish', '2'),
      execute: (request) => this.wechatOfficialAccount.execute(request, '2'),
    });
    this.wechatOfficialAccount.subscribe((actionId) => this.queueCompletedAction(actionId));
  }

  async list(request: Request, workspaceSlug: string): Promise<RunView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ run: workflowRuns, workflow: workflows, version: workflowVersions })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowRuns.workflowVersionId, workflowVersions.id))
      .where(eq(workflowRuns.workspaceId, team.id))
      .orderBy(desc(workflowRuns.createdAt));
    return Promise.all(rows.map(({ run, workflow, version }) => this.toView(run, workflow, version, workspaceSlug, 'You', false)));
  }

  async get(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select({ run: workflowRuns, workflow: workflows, version: workflowVersions })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .innerJoin(workflowVersions, eq(workflowRuns.workflowVersionId, workflowVersions.id))
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Run not found');
    return this.toView(row.run, row.workflow, row.version, workspaceSlug, 'You', true);
  }

  async events(request: Request, workspaceSlug: string, runId: string, afterSequence = 0): Promise<RunProgressEvent[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    const rows = await this.db.select().from(workflowRunEvents).where(and(eq(workflowRunEvents.runId, runId), gt(workflowRunEvents.sequence, afterSequence))).orderBy(asc(workflowRunEvents.sequence));
    return rows.map((row) => ({ runId: row.runId, sequence: row.sequence, type: row.type, payload: sanitizeWorkflowImages(row.payload), occurredAt: row.createdAt.toISOString() }));
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createForVersion(request: Request, workflowVersionId: string, input: CreateRunRequest): Promise<{ runId: string }> {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const [version] = await this.db.select({ version: workflowVersions, workflow: workflows })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(and(eq(workflowVersions.id, workflowVersionId), eq(workflowVersions.workspaceId, workspace.id), eq(workflowVersions.published, true))).limit(1);
    if (!version) throw new NotFoundException('Published workflow version not found');
    return this.createScheduledRun(version.workflow.workspaceId, version.workflow.id, workflowVersionId, input?.input ?? null);
  }

  async createScheduledRun(workspaceId: string, workflowId: string, workflowVersionId: string, input: unknown): Promise<{ runId: string }> {
    const runId = `run_${randomUUID()}`;
    await this.db.insert(workflowRuns).values({ id: runId, workspaceId, workflowId, workflowVersionId, input: sanitizeWorkflowImages(input ?? null), status: 'queued' });
    await this.publish(runId, 'run.status', { status: 'queued' });
    this.schedule(runId);
    return { runId };
  }

  async cancel(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const finishedAt = new Date();
    const [run] = await this.db.update(workflowRuns).set({ status: 'cancelled', currentNodeId: null, finishedAt, updatedAt: finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id), sql`${workflowRuns.status} in ('queued', 'running', 'waiting_for_input')`)).returning();
    if (!run) return this.get(request, workspaceSlug, runId);
    this.activeRuns.get(runId)?.abort();
    const pendingActions = await this.db.select({ id: workflowPendingActions.id }).from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, runId), eq(workflowPendingActions.status, 'pending')));
    await Promise.all(pendingActions.map(({ id }) => this.wechatOfficialAccount.cancel(id)));
    await this.db.update(workflowPendingActions).set({ status: 'cancelled', qrCode: null, updatedAt: finishedAt }).where(and(eq(workflowPendingActions.runId, runId), eq(workflowPendingActions.status, 'pending')));
    await this.db.update(workflowNodeRuns).set({ status: 'cancelled', error: 'Workflow run cancelled.', finishedAt }).where(and(eq(workflowNodeRuns.runId, runId), inArray(workflowNodeRuns.status, ['queued', 'running', 'waiting_for_input'])));
    await this.publish(runId, 'run.status', { status: 'cancelled' });
    const [workflow] = await this.db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, run.workflowVersionId)).limit(1);
    if (!workflow || !version) throw new NotFoundException('Run dependencies not found');
    return this.toView(run, workflow, version, workspaceSlug, 'You', true);
  }

  async refreshPendingAction(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [run] = await this.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id))).limit(1);
    if (!run) throw new NotFoundException('Run not found');
    if (run.status !== 'waiting_for_input') throw new NotFoundException('Run has no pending action.');
    const [action] = await this.db.select().from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, runId), inArray(workflowPendingActions.status, ['pending', 'expired']))).orderBy(desc(workflowPendingActions.createdAt)).limit(1);
    if (!action) throw new NotFoundException('Pending action not found.');
    const refreshed = await this.wechatOfficialAccount.refresh(action.id);
    const [updatedAction] = await this.db.update(workflowPendingActions).set({ status: 'pending', type: refreshed.type, title: refreshed.title, description: refreshed.description, qrCode: refreshed.qrCode, expiresAt: refreshed.expiresAt, externalOperationId: refreshed.externalOperationId ?? null, updatedAt: new Date() }).where(and(eq(workflowPendingActions.id, action.id), inArray(workflowPendingActions.status, ['pending', 'expired']))).returning();
    if (!updatedAction) {
      await this.wechatOfficialAccount.cancel(action.id);
      return this.get(request, workspaceSlug, runId);
    }
    await this.publish(runId, 'pending_action.updated', { actionId: action.id, status: 'pending', expiresAt: refreshed.expiresAt?.toISOString() ?? null });
    return this.get(request, workspaceSlug, runId);
  }

  private schedule(runId: string): void {
    setTimeout(() => { void this.execute(runId); }, 0);
  }

  private async execute(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) return;
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    try {
      const [pendingRun] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (!pendingRun || (pendingRun.status !== 'queued' && pendingRun.status !== 'waiting_for_input')) return;
      const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, pendingRun.workflowVersionId)).limit(1);
      if (!version) throw new Error('Workflow version not found');
      const definition = version.definition as StoredWorkflowDefinition | null;
      if (!definition || definition.schemaVersion !== 4 || !Array.isArray(definition.edges)) throw new Error('Workflow schema version 4 is required.');
      let state: WorkflowSchedulerState;
      if (pendingRun.executionState) {
        state = structuredClone(pendingRun.executionState) as WorkflowSchedulerState;
      } else {
        const [existingNodeRun] = await this.db.select({ id: workflowNodeRuns.id }).from(workflowNodeRuns).where(eq(workflowNodeRuns.runId, runId)).limit(1);
        if (existingNodeRun) throw new Error('Workflow run scheduler state is unavailable and cannot be reconstructed.');
        state = createWorkflowSchedulerState(definition);
      }
      const [run] = await this.db.update(workflowRuns)
        .set({ status: 'running', executionState: state as StoredWorkflowExecutionState, updatedAt: new Date() })
        .where(and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, ['queued', 'waiting_for_input'])))
        .returning();
      if (!run) return;
      await this.publish(runId, 'run.status', { status: 'running' });

      while (true) {
        await this.assertActive(runId, abortController.signal);
        const active = state.active;
        const invocation = active ?? takeNextWorkflowInvocation(state);
        if (!invocation) break;
        const node = definition.nodes.find((candidate) => candidate.id === invocation.nodeId);
        if (!node) throw new Error('Workflow scheduler references an unavailable node.');

        const nodeRunId = active?.nodeRunId ?? `nrun_${randomUUID()}`;
        const position = active?.position ?? state.nextPosition + 1;
        let startedAt = new Date();
        if (!active) {
          state.nextPosition = position;
          state.active = { ...invocation, nodeRunId, position };
          await this.db.transaction((transaction) => {
            transaction.insert(workflowNodeRuns).values({ id: nodeRunId, runId, workspaceId: run.workspaceId, nodeId: node.id, position, type: node.type, typeVersion: node.typeVersion, status: 'running', input: sanitizeWorkflowImages(invocation.input), startedAt }).run();
            const [updatedRun] = transaction.update(workflowRuns).set({ currentNodeId: node.id, executionState: state as StoredWorkflowExecutionState, updatedAt: startedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
            if (!updatedRun) throw new RunCancelledError();
          });
        } else {
          const [existingNodeRun] = await this.db.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.id, nodeRunId)).limit(1);
          if (!existingNodeRun) throw new Error('Workflow scheduler node run is unavailable.');
          startedAt = existingNodeRun.startedAt ?? startedAt;
          await this.db.transaction((transaction) => {
            const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'running', input: sanitizeWorkflowImages(invocation.input), error: null, finishedAt: null, startedAt }).where(and(eq(workflowNodeRuns.id, nodeRunId), inArray(workflowNodeRuns.status, ['queued', 'waiting_for_input']))).returning().all();
            const [updatedRun] = transaction.update(workflowRuns).set({ currentNodeId: node.id, executionState: state as StoredWorkflowExecutionState, updatedAt: startedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
            if (!updatedNodeRun || !updatedRun) throw new RunCancelledError();
          });
        }
        await this.publish(runId, 'node.started', { nodeId: node.id, nodeRunId, position, type: node.type });

        const attempts = node.errorPolicy === 'retry' ? 2 : 1;
        let output: unknown;
        let artifactIds: string[] = [];
        let failure: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            await this.assertActive(runId, abortController.signal);
            if (attempt > 0) await this.db.update(workflowNodeRuns).set({ retryCount: attempt }).where(eq(workflowNodeRuns.id, nodeRunId));
            const nodeType = this.registry.resolve(node.type, node.typeVersion);
            const request: NodeExecutionRequest = {
              input: invocation.input,
              config: node.config,
              context: {
                workflowRunId: runId,
                workflowVersionId: run.workflowVersionId,
                nodeId: node.id,
                nodeRunId,
                pendingActionId: `pending_${randomUUID()}`,
                workspaceId: run.workspaceId,
                variables: { workflowInput: run.input },
              },
              signal: abortController.signal,
            };
            const result = await nodeType.execute(request);
            if (result.status === 'waiting_for_input') {
              await this.suspendRun(run.workspaceId, runId, nodeRunId, node.id, result);
              return;
            }
            await this.assertActive(runId, abortController.signal);
            const artifact = await this.createArtifactNode(run, node, result.output);
            output = artifact ? artifact.output : result.output;
            artifactIds = artifact ? [artifact.id] : [];
            failure = null;
            break;
          } catch (error) {
            failure = error;
            if (error instanceof RunCancelledError || abortController.signal.aborted) throw new RunCancelledError();
          }
        }
        if (failure) {
          const message = failure instanceof Error ? failure.message : 'Workflow node failed.';
          const [failedNodeRun] = await this.db.update(workflowNodeRuns).set({ status: 'failed', error: message, finishedAt: new Date() }).where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.status, 'running'))).returning();
          if (!failedNodeRun) throw new RunCancelledError();
          await this.publish(runId, 'node.failed', { nodeId: node.id, nodeRunId, error: message });
          throw new Error(message);
        }

        commitWorkflowInvocation(definition, state, node.id, output);
        delete state.active;
        const finishedAt = new Date();
        await this.db.transaction((transaction) => {
          const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'succeeded', output: sanitizeWorkflowImages(output), artifactIds, finishedAt }).where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.status, 'running'))).returning().all();
          const [updatedRun] = transaction.update(workflowRuns).set({ executionState: state as StoredWorkflowExecutionState, updatedAt: finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
          if (!updatedNodeRun || !updatedRun) throw new RunCancelledError();
        });
        await this.publish(runId, 'node.completed', { nodeId: node.id, nodeRunId, output: sanitizeWorkflowImages(output), artifactIds });
      }

      const result = workflowRunResult(state);
      const sanitizedResult = sanitizeWorkflowImages(result);
      const finishedAt = new Date();
      const [succeededRun] = await this.db.update(workflowRuns).set({ status: 'succeeded', result: sanitizedResult, executionState: state as StoredWorkflowExecutionState, currentNodeId: null, updatedAt: finishedAt, finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning();
      if (!succeededRun) return;
      await this.publish(runId, 'run.status', { status: 'succeeded', result: sanitizedResult });
    } catch (error) {
      if (error instanceof RunCancelledError) return;
      const [current] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (current?.status === 'cancelled') return;
      const message = error instanceof Error ? error.message : 'Workflow execution failed.';
      const failedAt = new Date();
      const failedRun = await this.db.transaction((transaction) => {
        const [updatedRun] = transaction.update(workflowRuns).set({ status: 'failed', result: { message }, currentNodeId: null, updatedAt: failedAt, finishedAt: failedAt }).where(and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, ['queued', 'running', 'waiting_for_input']))).returning().all();
        if (!updatedRun) return null;
        transaction.update(workflowNodeRuns).set({ status: 'failed', error: message, finishedAt: failedAt }).where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.status, 'running'))).run();
        return updatedRun;
      });
      if (!failedRun) return;
      await this.publish(runId, 'run.status', { status: 'failed', error: message });
    } finally {
      if (this.activeRuns.get(runId) === abortController) this.activeRuns.delete(runId);
    }
  }

  private async assertActive(runId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new RunCancelledError();
    const [run] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run || run.status !== 'running') throw new RunCancelledError();
  }

  private async suspendRun(workspaceId: string, runId: string, nodeRunId: string, nodeId: string, result: PendingNodeExecutionResult): Promise<void> {
    const now = new Date();
    const action = result.pendingAction;
    const [currentRun] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    const [currentNodeRun] = await this.db.select({ status: workflowNodeRuns.status }).from(workflowNodeRuns).where(eq(workflowNodeRuns.id, nodeRunId)).limit(1);
    if (currentRun?.status !== 'running' || currentNodeRun?.status !== 'running') {
      await this.wechatOfficialAccount.cancel(action.id);
      this.pendingCompletions.delete(action.id);
      return;
    }
    try {
      await this.db.transaction((transaction) => {
        transaction.insert(workflowPendingActions).values({ id: action.id, workspaceId, runId, nodeRunId, type: action.type, status: 'pending', title: action.title, description: action.description, qrCode: action.qrCode, expiresAt: action.expiresAt, externalOperationId: action.externalOperationId ?? null }).run();
        const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'waiting_for_input', error: null }).where(and(eq(workflowNodeRuns.id, nodeRunId), eq(workflowNodeRuns.status, 'running'))).returning().all();
        const [updatedRun] = transaction.update(workflowRuns).set({ status: 'waiting_for_input', currentNodeId: nodeId, updatedAt: now }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'running'))).returning().all();
        if (!updatedNodeRun || !updatedRun) throw new RunCancelledError();
      });
    } catch (error) {
      await this.wechatOfficialAccount.cancel(action.id);
      await this.db.update(workflowPendingActions).set({ status: 'cancelled', qrCode: null, updatedAt: new Date() }).where(and(eq(workflowPendingActions.id, action.id), eq(workflowPendingActions.status, 'pending')));
      this.pendingCompletions.delete(action.id);
      if (error instanceof RunCancelledError) return;
      throw error;
    }
    await this.publish(runId, 'node.waiting', { nodeId, nodeRunId, actionId: action.id, type: action.type });
    await this.publish(runId, 'run.status', { status: 'waiting_for_input', actionId: action.id });
    await this.flushCompletedActions();
  }

  private queueCompletedAction(actionId: string): void {
    if (!actionId.startsWith('pending_')) return;
    this.pendingCompletions.add(actionId);
    if (!this.completionFlush) this.completionFlush = this.flushCompletedActions().finally(() => { this.completionFlush = null; });
  }

  private async flushCompletedActions(): Promise<void> {
    while (this.pendingCompletions.size > 0) {
      const [actionId] = this.pendingCompletions;
      if (!await this.completePendingAction(actionId)) break;
      this.pendingCompletions.delete(actionId);
    }
  }

  private async completePendingAction(actionId: string): Promise<boolean> {
    const [action] = await this.db.select().from(workflowPendingActions).where(eq(workflowPendingActions.id, actionId)).limit(1);
    if (!action) return false;
    if (action.status !== 'pending') return true;
    const now = new Date();
    try {
      await this.db.transaction((transaction) => {
        const [updatedNodeRun] = transaction.update(workflowNodeRuns).set({ status: 'queued' }).where(and(eq(workflowNodeRuns.id, action.nodeRunId), eq(workflowNodeRuns.status, 'waiting_for_input'))).returning().all();
        const [updatedRun] = transaction.update(workflowRuns).set({ status: 'queued', updatedAt: now }).where(and(eq(workflowRuns.id, action.runId), eq(workflowRuns.status, 'waiting_for_input'))).returning().all();
        const [updatedAction] = transaction.update(workflowPendingActions).set({ status: 'completed', qrCode: null, updatedAt: now }).where(and(eq(workflowPendingActions.id, actionId), eq(workflowPendingActions.status, 'pending'))).returning().all();
        if (!updatedNodeRun || !updatedRun || !updatedAction) throw new RunCancelledError();
      });
    } catch (error) {
      if (error instanceof RunCancelledError) return true;
      throw error;
    }
    await this.publish(action.runId, 'pending_action.updated', { actionId, status: 'completed' });
    this.schedule(action.runId);
    return true;
  }

  private async createArtifactNode(run: typeof workflowRuns.$inferSelect, node: StoredWorkflowNode, output: unknown): Promise<{ id: string; output: unknown } | null> {
    if (node.type !== 'worklite/artifact') return null;
    const config = asRecord(node.config);
    if (!config || typeof config.name !== 'string' || !config.name.trim()) throw new Error('Artifact node requires a name and supported artifact type.');
    const type = config.type;
    if (type !== 'text' && type !== 'markdown' && type !== 'json') throw new Error('Artifact node requires a name and supported artifact type.');
    const content = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    const name = config.name.trim();
    const id = `art_${randomUUID()}`;
    await this.db.insert(artifacts).values({ id, workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, name, type, size: `${Buffer.byteLength(content, 'utf8')} B`, content });
    await this.publish(run.id, 'artifact.created', { artifactId: id, nodeId: node.id, name, type });
    return { id, output: { type: 'artifact', artifactId: id, name, artifactType: type } };
  }

  private async toView(run: typeof workflowRuns.$inferSelect, workflow: typeof workflows.$inferSelect, version: typeof workflowVersions.$inferSelect, workspaceSlug: string, initiator: string, details: boolean): Promise<RunView> {
    const end = run.finishedAt?.getTime() ?? (run.status === 'queued' ? null : Date.now());
    const definition = version.definition as StoredWorkflowDefinition | null;
    const hasArtifactNode = Boolean(definition?.nodes.some((node) => node.type === 'worklite/artifact'));
    const view: RunView = { id: run.id, workspaceSlug, workflowId: workflow.id, workflowName: workflow.name, version: `v${version.version}`, status: run.status, currentStep: run.currentNodeId, startedAt: run.createdAt.toISOString(), durationSeconds: end === null ? null : Math.max(0, Math.round((end - run.createdAt.getTime()) / 1000)), initiator, input: sanitizeWorkflowImages(run.input), result: sanitizeWorkflowImages(run.result), hasArtifactNode };
    if (!details) return view;
    const nodeRows = await this.db.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.runId, run.id)).orderBy(asc(workflowNodeRuns.position));
    const artifactRows = await this.db.select().from(artifacts).where(eq(artifacts.runId, run.id)).orderBy(asc(artifacts.createdAt));
    view.nodeRuns = nodeRows.map(toNodeRunView);
    view.artifacts = artifactRows.map((artifact) => toArtifactView(artifact, workspaceSlug, workflow.name));
    const [pendingAction] = await this.db.select().from(workflowPendingActions).where(and(eq(workflowPendingActions.runId, run.id), inArray(workflowPendingActions.status, ['pending', 'expired']))).orderBy(desc(workflowPendingActions.createdAt)).limit(1);
    view.pendingAction = pendingAction ? toPendingActionView(pendingAction) : null;
    return view;
  }

  private async publish(runId: string, type: RunProgressEvent['type'], payload: unknown): Promise<void> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const [row] = await this.db.insert(workflowRunEvents).values({ runId, sequence: sql<number>`coalesce((select max(sequence) from workflow_run_events where run_id = ${runId}), 0) + 1`, type, payload: sanitizeWorkflowImages(payload) }).returning();
      if (!row) return;
      const event: RunProgressEvent = { runId: row.runId, sequence: row.sequence, type: row.type, payload: sanitizeWorkflowImages(row.payload), occurredAt: row.createdAt.toISOString() };
      for (const listener of this.listeners) listener(event);
    });
    this.eventQueues.set(runId, next);
    try {
      await next;
    } finally {
      if (this.eventQueues.get(runId) === next) this.eventQueues.delete(runId);
    }
  }
}

function parseWorkflowAgentJson(value: string): unknown {
  const raw = value.trim().replace(/^\uFEFF/, '');
  const fenced = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  const candidate = fenced?.[1] ?? raw;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error('Agent node JSON output requires valid JSON.');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type GeneratedWorkflowImage = {
  type: 'workflow_image';
  model: string;
  mediaType: 'image/png';
  data: Array<{ b64Json: string }>;
};

function isGeneratedWorkflowImage(value: unknown): value is GeneratedWorkflowImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'workflow_image'
    && typeof record.model === 'string'
    && record.mediaType === 'image/png'
    && Array.isArray(record.data)
    && record.data.length > 0
    && record.data.every((item) => Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).b64Json === 'string');
}

function sanitizeWorkflowImages<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sanitizeWorkflowImages(item)) as T;
  if (isGeneratedWorkflowImage(value)) return {
    type: 'workflow_image_summary',
    model: value.model,
    mediaType: value.mediaType,
    imageCount: value.data.length,
  } as T;
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = sanitizeWorkflowImages(item);
  return output as T;
}

function toNodeRunView(row: typeof workflowNodeRuns.$inferSelect): WorkflowNodeRunView {
  return { id: row.id, runId: row.runId, nodeId: row.nodeId, position: row.position, type: row.type, typeVersion: row.typeVersion, status: row.status, input: sanitizeWorkflowImages(row.input), output: sanitizeWorkflowImages(row.output), artifactIds: row.artifactIds ?? [], error: row.error, retryCount: row.retryCount, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null };
}

function toArtifactView(row: typeof artifacts.$inferSelect, workspaceSlug: string, workflowName: string): ArtifactView {
  return { id: row.id, workspaceSlug, name: row.name, type: row.type, workflowName, runId: row.runId ?? '', size: row.size, createdAt: row.createdAt?.toISOString() ?? null, content: row.content };
}

function toPendingActionView(row: typeof workflowPendingActions.$inferSelect): WorkflowPendingActionView {
  return { id: row.id, runId: row.runId, nodeRunId: row.nodeRunId, type: row.type, status: row.status, title: row.title, description: row.description, qrCode: row.qrCode, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() };
}
