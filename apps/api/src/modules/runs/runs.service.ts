import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { ArtifactView, CreateRunRequest, RunProgressEvent, RunView, WorkflowNodeRunView, WorkflowSkillSetValue } from '@worklite/contracts';
import {
  artifacts,
  workflowNodeRuns,
  workflowRunEvents,
  workflowRuns,
  workflowVersions,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowNode,
} from '@worklite/db';
import { collectNodeInputs, getLeafNodeIds, NodeTypeRegistry, topologicallySortWorkflow, type NodeExecutionRequest } from '@worklite/workflow-engine';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { AgentExecutionsService } from '../agents/agent-executions.service';

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

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly agentExecutions: AgentExecutionsService,
  ) {
    this.registry.register({
      id: 'worklite/input',
      version: '1',
      inputSchema: { type: 'object' },
      outputSchema: {},
      configSchema: { type: 'object' },
      execute: async ({ context }) => ({ output: context.variables.workflowInput }),
    });
    this.registry.register({
      id: 'worklite/text',
      version: '1',
      inputSchema: { type: 'string' },
      outputSchema: { type: 'string' },
      configSchema: { type: 'object' },
      execute: async ({ config }) => {
        const value = asRecord(config)?.text;
        return { output: typeof value === 'string' ? value : '' };
      },
    });
    this.registry.register({
      id: 'worklite/skill-set',
      version: '1',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', required: ['type', 'skillIds'] },
      configSchema: { type: 'object', required: ['skillIds'] },
      execute: async ({ config }) => {
        const skillIds = asRecord(config)?.skillIds;
        if (!Array.isArray(skillIds) || skillIds.some((skillId) => typeof skillId !== 'string')) throw new Error('Skill Set node requires Skill identifiers.');
        return { output: { type: 'skill-set', skillIds: [...new Set(skillIds)] } satisfies WorkflowSkillSetValue };
      },
    });
    this.registry.register({
      id: 'worklite/generic-agent',
      version: '1',
      inputSchema: { type: 'object', required: ['context', 'systemPrompt'] },
      outputSchema: {},
      configSchema: { type: 'object', required: ['agentVersionId'] },
      execute: async (request) => {
        const config = asRecord(request.config);
        const inputs = asRecord(request.input);
        if (!config || typeof config.agentVersionId !== 'string' || !config.agentVersionId.trim()) throw new Error('Generic Agent node requires an AgentVersion.');
        if (!inputs || typeof inputs.systemPrompt !== 'string') throw new Error('Generic Agent node requires a systemPrompt input.');
        const skillSet = inputs.skills === undefined ? null : asRecord(inputs.skills);
        if (skillSet && (skillSet.type !== 'skill-set' || !Array.isArray(skillSet.skillIds) || skillSet.skillIds.some((skillId) => typeof skillId !== 'string'))) {
          throw new Error('Generic Agent skills input must come from a Skill Set node.');
        }
        const output = await this.agentExecutions.executeGenericWorkflowAgent(
          request.context.workspaceId,
          config.agentVersionId,
          inputs.context,
          inputs.systemPrompt,
          skillSet ? skillSet.skillIds as string[] : [],
          request.signal,
          (delta) => { void this.publish(request.context.workflowRunId, 'node.delta', { nodeId: request.context.nodeId, delta }); },
        );
        return { output };
      },
    });
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
    return rows.map((row) => ({ runId: row.runId, sequence: row.sequence, type: row.type, payload: row.payload, occurredAt: row.createdAt.toISOString() }));
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
    const runId = `run_${randomUUID()}`;
    await this.db.insert(workflowRuns).values({ id: runId, workspaceId: version.workflow.workspaceId, workflowId: version.workflow.id, workflowVersionId, input: input?.input ?? null, status: 'queued' });
    await this.publish(runId, 'run.status', { status: 'queued' });
    this.schedule(runId);
    return { runId };
  }

  async cancel(request: Request, workspaceSlug: string, runId: string): Promise<RunView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const finishedAt = new Date();
    const [run] = await this.db.update(workflowRuns).set({ status: 'cancelled', currentNodeId: null, finishedAt, updatedAt: finishedAt }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, team.id), sql`${workflowRuns.status} in ('queued', 'running')`)).returning();
    if (!run) return this.get(request, workspaceSlug, runId);
    this.activeRuns.get(runId)?.abort();
    await this.db.update(workflowNodeRuns).set({ status: 'cancelled', error: 'Workflow run cancelled.', finishedAt }).where(and(eq(workflowNodeRuns.runId, runId), inArray(workflowNodeRuns.status, ['queued', 'running'])));
    await this.publish(runId, 'run.status', { status: 'cancelled' });
    const [workflow] = await this.db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, run.workflowVersionId)).limit(1);
    if (!workflow || !version) throw new NotFoundException('Run dependencies not found');
    return this.toView(run, workflow, version, workspaceSlug, 'You', true);
  }

  private schedule(runId: string): void {
    setTimeout(() => { void this.execute(runId); }, 0);
  }

  private async execute(runId: string): Promise<void> {
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    try {
      const [run] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (!run || run.status === 'cancelled') return;
      const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, run.workflowVersionId)).limit(1);
      if (!version) throw new Error('Workflow version not found');
      const definition = version.definition as StoredWorkflowDefinition | null;
      if (!definition || definition.schemaVersion !== 3 || !Array.isArray(definition.edges)) throw new Error('Workflow schema version 3 is required.');
      const executionPlan = topologicallySortWorkflow(definition);
      await this.db.update(workflowRuns).set({ status: 'running', updatedAt: new Date() }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, 'queued')));
      await this.publish(runId, 'run.status', { status: 'running' });
      const outputs = new Map<string, unknown>();
      for (const [executionIndex, node] of executionPlan.entries()) {
        await this.assertActive(runId, abortController.signal);
        const input = collectNodeInputs(definition.edges, node.id, outputs);
        const position = executionIndex + 1;
        const nodeRunId = `nrun_${randomUUID()}`;
        await this.db.insert(workflowNodeRuns).values({ id: nodeRunId, runId, workspaceId: run.workspaceId, nodeId: node.id, position, type: node.type, typeVersion: node.typeVersion, status: 'queued', input });
        const startedAt = new Date();
        await this.db.update(workflowNodeRuns).set({ status: 'running', startedAt }).where(eq(workflowNodeRuns.id, nodeRunId));
        await this.db.update(workflowRuns).set({ currentNodeId: node.id, updatedAt: startedAt }).where(eq(workflowRuns.id, runId));
        await this.publish(runId, 'node.started', { nodeId: node.id, nodeRunId, position, type: node.type });
        const attempts = node.errorPolicy === 'retry' ? 2 : 1;
        let output: unknown;
        let artifactIds: string[] = [];
        let failure: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            if (attempt > 0) await this.db.update(workflowNodeRuns).set({ retryCount: attempt }).where(eq(workflowNodeRuns.id, nodeRunId));
            const definition = this.registry.resolve(node.type, node.typeVersion);
            const request: NodeExecutionRequest = { input, config: node.config, context: { workflowRunId: runId, workflowVersionId: run.workflowVersionId, nodeId: node.id, workspaceId: run.workspaceId, variables: { workflowInput: run.input } }, signal: abortController.signal };
            const result = await definition.execute(request);
            const artifact = await this.createFileArtifact(run, node, result.output);
            output = artifact ? artifact.output : result.output;
            artifactIds = artifact ? [artifact.id] : [];
            failure = null;
            break;
          } catch (error) {
            failure = error;
            if (abortController.signal.aborted) throw new RunCancelledError();
          }
        }
        if (failure) {
          const message = failure instanceof Error ? failure.message : 'Workflow node failed.';
          await this.db.update(workflowNodeRuns).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(workflowNodeRuns.id, nodeRunId));
          await this.publish(runId, 'node.failed', { nodeId: node.id, nodeRunId, error: message });
          throw new Error(message);
        }
        await this.db.update(workflowNodeRuns).set({ status: 'succeeded', output, artifactIds, finishedAt: new Date() }).where(eq(workflowNodeRuns.id, nodeRunId));
        await this.publish(runId, 'node.completed', { nodeId: node.id, nodeRunId, output, artifactIds });
        outputs.set(node.id, output);
      }
      const result = Object.fromEntries(getLeafNodeIds(definition).map((nodeId) => [nodeId, outputs.get(nodeId)]));
      await this.db.update(workflowRuns).set({ status: 'succeeded', result, currentNodeId: null, updatedAt: new Date(), finishedAt: new Date() }).where(eq(workflowRuns.id, runId));
      await this.publish(runId, 'run.status', { status: 'succeeded', result });
    } catch (error) {
      if (error instanceof RunCancelledError) return;
      const [current] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      if (current?.status === 'cancelled') return;
      const message = error instanceof Error ? error.message : 'Workflow execution failed.';
      await this.db.update(workflowRuns).set({ status: 'failed', result: { message }, updatedAt: new Date(), finishedAt: new Date() }).where(eq(workflowRuns.id, runId));
      await this.publish(runId, 'run.status', { status: 'failed', error: message });
    } finally {
      if (this.activeRuns.get(runId) === abortController) this.activeRuns.delete(runId);
    }
  }

  private async assertActive(runId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new RunCancelledError();
    const [run] = await this.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run || run.status === 'cancelled') throw new RunCancelledError();
  }

  private async createFileArtifact(run: typeof workflowRuns.$inferSelect, node: StoredWorkflowNode, output: unknown): Promise<{ id: string; output: unknown } | null> {
    const config = asRecord(node.config);
    if (config?.outputType !== 'file') return null;
    const file = asRecord(output) && asRecord((output as Record<string, unknown>).file) ? (output as Record<string, unknown>).file : output;
    const content = typeof file === 'string' ? file : JSON.stringify(file ?? '');
    const type = config.fileType === 'json' || config.fileType === 'markdown' || config.fileType === 'text' ? config.fileType : 'text';
    const name = typeof config.fileName === 'string' && config.fileName.trim() ? config.fileName.trim() : 'workflow-output.txt';
    const id = `art_${randomUUID()}`;
    await this.db.insert(artifacts).values({ id, workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, name, type, size: `${Buffer.byteLength(content, 'utf8')} B`, content });
    await this.publish(run.id, 'artifact.created', { artifactId: id, nodeId: node.id, name, type });
    return { id, output: { type: 'file', artifactId: id, name, artifactType: type } };
  }

  private async toView(run: typeof workflowRuns.$inferSelect, workflow: typeof workflows.$inferSelect, version: typeof workflowVersions.$inferSelect, workspaceSlug: string, initiator: string, details: boolean): Promise<RunView> {
    const end = run.finishedAt?.getTime() ?? (run.status === 'queued' ? null : Date.now());
    const view: RunView = { id: run.id, workspaceSlug, workflowId: workflow.id, workflowName: workflow.name, version: `v${version.version}`, status: run.status, currentStep: run.currentNodeId, startedAt: run.createdAt.toISOString(), durationSeconds: end === null ? null : Math.max(0, Math.round((end - run.createdAt.getTime()) / 1000)), initiator, input: run.input, result: run.result };
    if (!details) return view;
    const nodeRows = await this.db.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.runId, run.id)).orderBy(asc(workflowNodeRuns.position));
    const artifactRows = await this.db.select().from(artifacts).where(eq(artifacts.runId, run.id)).orderBy(asc(artifacts.createdAt));
    view.nodeRuns = nodeRows.map(toNodeRunView);
    view.artifacts = artifactRows.map((artifact) => toArtifactView(artifact, workspaceSlug, workflow.name));
    return view;
  }

  private async publish(runId: string, type: RunProgressEvent['type'], payload: unknown): Promise<void> {
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const [row] = await this.db.insert(workflowRunEvents).values({ runId, sequence: sql<number>`coalesce((select max(sequence) from workflow_run_events where run_id = ${runId}), 0) + 1`, type, payload }).returning();
      if (!row) return;
      const event: RunProgressEvent = { runId: row.runId, sequence: row.sequence, type: row.type, payload: row.payload, occurredAt: row.createdAt.toISOString() };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toNodeRunView(row: typeof workflowNodeRuns.$inferSelect): WorkflowNodeRunView {
  return { id: row.id, runId: row.runId, nodeId: row.nodeId, position: row.position, type: row.type, typeVersion: row.typeVersion, status: row.status, input: row.input, output: row.output, artifactIds: row.artifactIds ?? [], error: row.error, retryCount: row.retryCount, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null };
}

function toArtifactView(row: typeof artifacts.$inferSelect, workspaceSlug: string, workflowName: string): ArtifactView {
  return { id: row.id, workspaceSlug, name: row.name, type: row.type, workflowName, runId: row.runId ?? '', size: row.size, createdAt: row.createdAt.toISOString(), content: row.content };
}
