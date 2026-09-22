import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  ApplyWorkflowDraftOperationsRequest,
  CreateWorkflowRequest,
  ImportWorkflowRequest,
  PortableWorkflowDocument,
  WorkflowDefinition,
  WorkflowDashboardBinding,
  WorkflowDashboardElement,
  WorkflowDashboardField,
  WorkflowDetailView,
  WorkflowEditOperation,
  WorkflowPlan,
  WorkflowVersionView,
  WorkflowView,
} from '@worklite/contracts';
import {
  emptyWorkflowDefinition,
  workflowDrafts,
  workflowEditRevisions,
  workflowVersions,
  workflowRuns,
  workflowSchedules,
  wechatOfficialAccounts,
  mcpServers,
  skills,
  workflows,
  type Database,
  type StoredWorkflowDefinition,
  type StoredWorkflowEditOperation,
} from '@worklite/db';
import { listWorkflowNodeCapabilities, validateWorkflowControlFlow, workflowEdgeRequiresComparisonValue, type WorkflowNodeCapability, type WorkflowPortDefinition } from '@worklite/workflow-engine';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { WorkflowSchedulesService } from './workflow-schedules.service';

@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly schedules: WorkflowSchedulesService,
  ) {}

  async list(request: Request, workspaceSlug: string): Promise<WorkflowView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(workflows).where(eq(workflows.workspaceId, workspace.id));
    return Promise.all(rows.map((row) => this.toView(row, workspaceSlug)));
  }

  async get(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const row = await this.findWorkflow(workspace.id, workflowId);
    if (!row) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(row);
    return this.toDetail(row, workspaceSlug);
  }

  async create(request: Request, workspaceSlug: string, input: CreateWorkflowRequest): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Workflow name is required.');
    const workflowId = `wf_${randomUUID()}`;
    const draftId = `wfd_${randomUUID()}`;
    const revisionId = `wfr_${randomUUID()}`;
    const definition = normalizeDefinition(input.definition ?? emptyWorkflowDefinition);
    validateDefinition(definition, false);
    await this.validateWorkspaceReferences(workspace.id, definition);
    await this.db.transaction((transaction) => {
      transaction.insert(workflows).values({ id: workflowId, workspaceId: workspace.id, name, state: 'draft' }).run();
      transaction.insert(workflowDrafts).values({ id: draftId, workspaceId: workspace.id, workflowId, currentRevisionId: revisionId, definition }).run();
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workspace.id, workflowId, draftId, parentRevisionId: null, source: 'manual', operations: [], snapshot: definition }).run();
    });
    return this.get(request, workspaceSlug, workflowId);
  }

  async exportWorkflow(request: Request, workspaceSlug: string, workflowId: string): Promise<PortableWorkflowDocument> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft) throw new NotFoundException('Workflow draft not found');
    const skillIds = collectWorkflowResourceIds(draft.definition, 'skillIds');
    const mcpServerIds = collectWorkflowResourceIds(draft.definition, 'mcpServerIds');
    const [skillRows, mcpRows] = await Promise.all([
      skillIds.length === 0 ? [] : this.db.select({ id: skills.id, name: skills.name }).from(skills).where(and(eq(skills.workspaceId, workspace.id), inArray(skills.id, skillIds))),
      mcpServerIds.length === 0 ? [] : this.db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(and(eq(mcpServers.workspaceId, workspace.id), inArray(mcpServers.id, mcpServerIds))),
    ]);
    if (skillRows.length !== skillIds.length) throw new BadRequestException('Every Workflow Agent Skill must belong to this workspace before export.');
    if (mcpRows.length !== mcpServerIds.length) throw new BadRequestException('Every Workflow Agent MCP server must belong to this workspace before export.');
    const skillsById = new Map(skillRows.map((row) => [row.id, row.name]));
    const mcpById = new Map(mcpRows.map((row) => [row.id, row.name]));
    const definition = structuredClone(draft.definition) as WorkflowDefinition;
    definition.nodes = definition.nodes.map((node) => {
      const config = isRecord(node.config) ? { ...node.config } : {};
      if (node.type === 'worklite/agent') {
        config.skills = readStringArray(config.skillIds).map((id) => ({ name: skillsById.get(id)! }));
        config.mcpServers = readStringArray(config.mcpServerIds).map((id) => ({ name: mcpById.get(id)! }));
        delete config.skillIds;
        delete config.mcpServerIds;
      }
      return { ...node, config };
    });
    return { format: 'worklite.workflow', version: 1, workflow: { name: workflow.name, definition: definition as PortableWorkflowDocument['workflow']['definition'] } };
  }

  async importWorkflow(request: Request, workspaceSlug: string, input: ImportWorkflowRequest): Promise<WorkflowDetailView> {
    if (!isRecord(input) || input.format !== 'worklite.workflow' || input.version !== 1 || !isRecord(input.workflow)) throw new BadRequestException('WorkLite workflow JSON version 1 is required.');
    const name = typeof input.workflow.name === 'string' ? input.workflow.name.trim() : '';
    if (!name || !isRecord(input.workflow.definition)) throw new BadRequestException('The imported workflow name and definition are required.');
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const definition = normalizeDefinition(input.workflow.definition as unknown as WorkflowDefinition);
    for (const node of definition.nodes) {
      const config = isRecord(node.config) ? { ...node.config } : {};
      if (node.type === 'worklite/agent') {
        const skillNames = readPortableNames(config.skills, 'Skill');
        const mcpNames = readPortableNames(config.mcpServers, 'MCP server');
        const [skillRows, mcpRows] = await Promise.all([
          skillNames.length === 0 ? [] : this.db.select({ id: skills.id, name: skills.name }).from(skills).where(and(eq(skills.workspaceId, workspace.id), inArray(skills.name, skillNames))),
          mcpNames.length === 0 ? [] : this.db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).where(and(eq(mcpServers.workspaceId, workspace.id), inArray(mcpServers.name, mcpNames))),
        ]);
        config.skillIds = resolvePortableNames(skillNames, skillRows, 'Skill');
        config.mcpServerIds = resolvePortableNames(mcpNames, mcpRows, 'MCP server');
        delete config.skills;
        delete config.mcpServers;
      }
      node.config = config;
    }
    validateDefinition(definition, false);
    return this.create(request, workspaceSlug, { name, definition });
  }

  async delete(request: Request, workspaceSlug: string, workflowId: string): Promise<void> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    await this.db.transaction((transaction) => {
      transaction.delete(workflowSchedules).where(and(eq(workflowSchedules.workspaceId, workspace.id), eq(workflowSchedules.workflowId, workflowId))).run();
      transaction.delete(workflowRuns).where(and(eq(workflowRuns.workspaceId, workspace.id), eq(workflowRuns.workflowId, workflowId))).run();
      transaction.delete(workflowEditRevisions).where(and(eq(workflowEditRevisions.workspaceId, workspace.id), eq(workflowEditRevisions.workflowId, workflowId))).run();
      transaction.delete(workflowDrafts).where(and(eq(workflowDrafts.workspaceId, workspace.id), eq(workflowDrafts.workflowId, workflowId))).run();
      transaction.delete(workflowVersions).where(and(eq(workflowVersions.workspaceId, workspace.id), eq(workflowVersions.workflowId, workflowId))).run();
      transaction.delete(workflows).where(and(eq(workflows.workspaceId, workspace.id), eq(workflows.id, workflowId))).run();
    });
  }

  async update(request: Request, workspaceSlug: string, workflowId: string, input: Partial<CreateWorkflowRequest>): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const existing = await this.findWorkflow(workspace.id, workflowId);
    if (!existing) throw new NotFoundException('Workflow not found');
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new BadRequestException('Workflow name is required.');
    await this.db.update(workflows).set({ name, updatedAt: new Date() }).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspace.id)));
    return this.get(request, workspaceSlug, workflowId);
  }

  async applyOperations(request: Request, workspaceSlug: string, workflowId: string, input: ApplyWorkflowDraftOperationsRequest): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    if (!input || typeof input.baseRevisionId !== 'string' || (!Array.isArray(input.operations) && !input.plan)) throw new BadRequestException('A base revision and workflow operations or plan are required.');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft || draft.currentRevisionId !== input.baseRevisionId) throw new ConflictException('The workflow draft changed. Reload it before applying edits.');
    const currentRevision = await this.loadRevision(workspace.id, input.baseRevisionId);
    if (!currentRevision) throw new ConflictException('The workflow base revision is unavailable.');
    const operations = input.plan ? buildPlanOperations(currentRevision.snapshot, input.plan) : input.operations;
    if (!operations || operations.length === 0) throw new BadRequestException('At least one workflow operation is required.');
    const nextDefinition = applyOperations(currentRevision.snapshot, operations);
    validateDefinition(nextDefinition, false);
    await this.validateWorkspaceReferences(workspace.id, nextDefinition);
    const revisionId = `wfr_${randomUUID()}`;
    const revisionSource = input.plan ? 'assistant' : input.source ?? 'manual';
    await this.db.transaction((transaction) => {
      const current = transaction.select({ currentRevisionId: workflowDrafts.currentRevisionId }).from(workflowDrafts).where(and(eq(workflowDrafts.id, draft.id), eq(workflowDrafts.workspaceId, workspace.id))).limit(1).all()[0];
      if (!current || current.currentRevisionId !== input.baseRevisionId) throw new ConflictException('The workflow draft changed. Reload it before applying edits.');
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workspace.id, workflowId, draftId: draft.id, parentRevisionId: input.baseRevisionId, source: revisionSource, sourceInstruction: input.sourceInstruction, operations: operations as StoredWorkflowEditOperation[], snapshot: nextDefinition }).run();
      transaction.update(workflowDrafts).set({ currentRevisionId: revisionId, definition: nextDefinition, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id)).run();
      transaction.update(workflows).set({ updatedAt: new Date() }).where(eq(workflows.id, workflowId)).run();
    });
    return this.get(request, workspaceSlug, workflowId);
  }

  async undo(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowDetailView> {
    return this.moveDraftPointer(request, workspaceSlug, workflowId, 'undo');
  }

  async redo(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowDetailView> {
    return this.moveDraftPointer(request, workspaceSlug, workflowId, 'redo');
  }

  async publish(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowVersionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft || !draft.currentRevisionId) throw new BadRequestException('The workflow has no draft revision.');
    validateDefinition(draft.definition, true);
    const skillIds = collectWorkflowResourceIds(draft.definition, 'skillIds');
    const mcpServerIds = collectWorkflowResourceIds(draft.definition, 'mcpServerIds');
    const [availableSkills, availableMcpServers] = await Promise.all([
      skillIds.length === 0 ? [] : this.db.select({ id: skills.id }).from(skills).where(and(eq(skills.workspaceId, workspace.id), inArray(skills.id, skillIds))),
      mcpServerIds.length === 0 ? [] : this.db.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.workspaceId, workspace.id), inArray(mcpServers.id, mcpServerIds))),
    ]);
    if (availableSkills.length !== skillIds.length) throw new BadRequestException('Every Workflow Agent Skill must belong to this workspace.');
    if (availableMcpServers.length !== mcpServerIds.length) throw new BadRequestException('Every Workflow Agent MCP server must belong to this workspace.');
    const latest = await this.db.select({ version: workflowVersions.version }).from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId)).orderBy(desc(workflowVersions.version)).limit(1);
    const versionNumber = (latest[0]?.version ?? 0) + 1;
    const versionId = `wfv_${randomUUID()}`;
    const publishedAt = new Date();
    await this.db.transaction((transaction) => {
      transaction.insert(workflowVersions).values({ id: versionId, workspaceId: workspace.id, workflowId, version: versionNumber, published: true, schemaVersion: draft.definition.schemaVersion, nodes: draft.definition.nodes, definition: draft.definition, sourceRevisionId: draft.currentRevisionId, publishedAt, publishedBy: 'You' }).run();
      transaction.update(workflows).set({ state: 'published', updatedAt: publishedAt }).where(eq(workflows.id, workflowId)).run();
    });
    const [version] = await this.db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId)).limit(1);
    if (!version) throw new NotFoundException('Workflow version could not be published');
    await this.schedules.syncPublishedVersion(version);
    return toVersionView(version);
  }

  async versions(request: Request, workspaceSlug: string, workflowId: string): Promise<WorkflowVersionView[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    const rows = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.published, true))).orderBy(desc(workflowVersions.version));
    return rows.map(toVersionView);
  }

  async version(request: Request, workspaceSlug: string, versionId: string): Promise<WorkflowVersionView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.id, versionId), eq(workflowVersions.published, true))).limit(1);
    if (!row || row.workspaceId !== workspace.id) throw new NotFoundException('Workflow version not found');
    return toVersionView(row);
  }

  private async moveDraftPointer(request: Request, workspaceSlug: string, workflowId: string, direction: 'undo' | 'redo'): Promise<WorkflowDetailView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const workflow = await this.findWorkflow(workspace.id, workflowId);
    if (!workflow) throw new NotFoundException('Workflow not found');
    await this.ensureDraft(workflow);
    const draft = await this.loadDraft(workspace.id, workflowId);
    if (!draft?.currentRevisionId) return this.get(request, workspaceSlug, workflowId);
    const current = await this.loadRevision(workspace.id, draft.currentRevisionId);
    if (!current) return this.get(request, workspaceSlug, workflowId);
    const target = direction === 'undo'
      ? current.parentRevisionId ? await this.loadRevision(workspace.id, current.parentRevisionId) : null
      : (await this.db.select().from(workflowEditRevisions).where(and(eq(workflowEditRevisions.workspaceId, workspace.id), eq(workflowEditRevisions.draftId, draft.id), eq(workflowEditRevisions.parentRevisionId, current.id))).orderBy(desc(workflowEditRevisions.createdAt)).limit(1))[0] ?? null;
    if (!target) return this.get(request, workspaceSlug, workflowId);
    await this.db.update(workflowDrafts).set({ currentRevisionId: target.id, definition: target.snapshot, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id));
    return this.get(request, workspaceSlug, workflowId);
  }

  private async validateWorkspaceReferences(workspaceId: string, definition: StoredWorkflowDefinition): Promise<void> {
    const skillIds = collectWorkflowResourceIds(definition, 'skillIds');
    const mcpServerIds = collectWorkflowResourceIds(definition, 'mcpServerIds');
    const accountIds = definition.nodes.filter((node) => node.type === 'wechat-official-account/publish').map((node) => isRecord(node.config) && typeof node.config.accountId === 'string' ? node.config.accountId : '').filter(Boolean);
    const [availableSkills, availableMcpServers, availableAccounts] = await Promise.all([
      skillIds.length === 0 ? [] : this.db.select({ id: skills.id }).from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds))),
      mcpServerIds.length === 0 ? [] : this.db.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, mcpServerIds))),
      accountIds.length === 0 ? [] : this.db.select({ id: wechatOfficialAccounts.id }).from(wechatOfficialAccounts).where(and(eq(wechatOfficialAccounts.workspaceId, workspaceId), inArray(wechatOfficialAccounts.id, accountIds))),
    ]);
    if (availableSkills.length !== skillIds.length) throw new BadRequestException('Every Workflow Skill must belong to this workspace.');
    if (availableMcpServers.length !== mcpServerIds.length) throw new BadRequestException('Every Workflow MCP server must belong to this workspace.');
    if (availableAccounts.length !== new Set(accountIds).size) throw new BadRequestException('Every WeChat Official Account must belong to this workspace.');
  }

  private async findWorkflow(workspaceId: string, workflowId: string) {
    const [row] = await this.db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspaceId))).limit(1);
    return row;
  }

  private async ensureDraft(workflow: typeof workflows.$inferSelect): Promise<void> {
    const [existing] = await this.db.select({ id: workflowDrafts.id }).from(workflowDrafts).where(eq(workflowDrafts.workflowId, workflow.id)).limit(1);
    if (existing) return;
    const draftId = `wfd_${randomUUID()}`;
    const revisionId = `wfr_${randomUUID()}`;
    await this.db.transaction((transaction) => {
      transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: workflow.workspaceId, workflowId: workflow.id, draftId, parentRevisionId: null, source: 'migration', sourceInstruction: 'Initialized from the existing workflow definition.', operations: [], snapshot: emptyWorkflowDefinition }).run();
      transaction.insert(workflowDrafts).values({ id: draftId, workspaceId: workflow.workspaceId, workflowId: workflow.id, currentRevisionId: revisionId, definition: emptyWorkflowDefinition }).run();
    });
  }

  private async loadDraft(workspaceId: string, workflowId: string) {
    const [draft] = await this.db.select().from(workflowDrafts).where(and(eq(workflowDrafts.workspaceId, workspaceId), eq(workflowDrafts.workflowId, workflowId))).limit(1);
    return draft;
  }

  private async loadRevision(workspaceId: string, revisionId: string) {
    const [revision] = await this.db.select().from(workflowEditRevisions).where(and(eq(workflowEditRevisions.workspaceId, workspaceId), eq(workflowEditRevisions.id, revisionId))).limit(1);
    return revision;
  }

  private async toDetail(row: typeof workflows.$inferSelect, workspaceSlug: string): Promise<WorkflowDetailView> {
    const view = await this.toView(row, workspaceSlug);
    const draft = await this.loadDraft(row.workspaceId, row.id);
    if (!draft) throw new NotFoundException('Workflow draft not found');
    validateDefinition(draft.definition, false);
    const currentRevision = draft.currentRevisionId ? await this.loadRevision(row.workspaceId, draft.currentRevisionId) : null;
    const canRedo = currentRevision
      ? (await this.db.select({ id: workflowEditRevisions.id }).from(workflowEditRevisions).where(and(eq(workflowEditRevisions.draftId, draft.id), eq(workflowEditRevisions.parentRevisionId, currentRevision.id))).limit(1)).length > 0
      : false;
    return { ...view, draft: { id: draft.id, workflowId: draft.workflowId, revisionId: draft.currentRevisionId ?? '', definition: draft.definition as WorkflowDefinition, canUndo: Boolean(currentRevision?.parentRevisionId), canRedo, updatedAt: draft.updatedAt.toISOString() } };
  }

  private async toView(row: typeof workflows.$inferSelect, workspaceSlug: string): Promise<WorkflowView> {
    const [version] = await this.db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, row.id), eq(workflowVersions.published, true))).orderBy(desc(workflowVersions.version)).limit(1);
    const [lastRun] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, row.id)).orderBy(desc(workflowRuns.createdAt)).limit(1);
    const definition = version?.definition as StoredWorkflowDefinition | null;
    return { id: row.id, workspaceSlug, latestVersionId: version?.id ?? null, latestVersion: version?.version ?? null, name: row.name, state: row.state, stepCount: definition?.nodes.length ?? version?.nodes.length ?? 0, dashboard: definition ? readDashboardBinding(definition) : null, lastRunStatus: lastRun?.status ?? null, lastRunAt: lastRun?.createdAt.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() };
  }
}

function normalizeDefinition(input: WorkflowDefinition | StoredWorkflowDefinition): StoredWorkflowDefinition {
  const definition = structuredClone(input) as StoredWorkflowDefinition;
  return { schemaVersion: definition.schemaVersion ?? 4, input: definition.input ?? {}, defaults: definition.defaults ?? { errorPolicy: 'stop' }, nodes: definition.nodes ?? [], edges: definition.edges ?? [] };
}

function buildPlanOperations(current: StoredWorkflowDefinition, plan: WorkflowPlan): WorkflowEditOperation[] {
  if (!plan || !Array.isArray(plan.nodes) || !Array.isArray(plan.edges)) throw new BadRequestException('The Workflow Plan must contain nodes and edges arrays.');
  const capabilities = new Map(listWorkflowNodeCapabilities().map((capability) => [`${capability.id}@${capability.version}`, capability]));
  const keys = new Set<string>();
  const ids = new Map<string, string>();
  const nextNodes = plan.nodes.map((node, index) => {
    const key = typeof node?.key === 'string' ? node.key.trim() : '';
    if (!key || keys.has(key) || (node.errorPolicy !== undefined && node.errorPolicy !== 'stop' && node.errorPolicy !== 'retry')) throw new BadRequestException('The Workflow Plan contains a duplicate or invalid node key.');
    const typeVersion = node.typeVersion ?? '1';
    const capability = capabilities.get(`${node.type}@${typeVersion}`);
    if (!capability) throw new BadRequestException(`The node type ${node.type}@${typeVersion} is not supported.`);
    const id = `wn_${randomUUID()}`;
    keys.add(key);
    ids.set(key, id);
    return {
      id,
      position: { x: 80 + (index % 4) * 280, y: 80 + Math.floor(index / 4) * 180 },
      type: capability.id,
      typeVersion: capability.version,
      config: structuredClone(node.config),
      errorPolicy: node.errorPolicy ?? plan.defaults?.errorPolicy ?? current.defaults.errorPolicy,
    };
  });
  const nextEdges = plan.edges.map((edge) => {
    const sourceNodeId = ids.get(edge.source);
    const targetNodeId = ids.get(edge.target);
    if (!sourceNodeId || !targetNodeId) throw new BadRequestException('The Workflow Plan references an unavailable node key.');
    const source = nextNodes.find((node) => node.id === sourceNodeId);
    const target = nextNodes.find((node) => node.id === targetNodeId);
    const sourceCapability = source ? capabilities.get(`${source.type}@${source.typeVersion}`) : undefined;
    const targetCapability = target ? capabilities.get(`${target.type}@${target.typeVersion}`) : undefined;
    const sourcePort = edge.sourcePort ?? sourceCapability?.outputs[0]?.name;
    const targetPort = edge.targetPort ?? targetCapability?.inputs.find((port) => port.required)?.name ?? targetCapability?.inputs[0]?.name;
    if (!sourcePort || !targetPort) throw new BadRequestException('The Workflow Plan edge must connect declared ports.');
    return {
      id: `we_${randomUUID()}`,
      sourceNodeId,
      sourcePort,
      targetNodeId,
      targetPort,
      ...(edge.condition ? { condition: structuredClone(edge.condition) } : {}),
      ...(edge.maxTraversals !== undefined ? { maxTraversals: edge.maxTraversals } : {}),
    };
  });
  return [
    ...current.edges.map((edge) => ({ type: 'removeEdge' as const, edgeId: edge.id })),
    ...current.nodes.map((node) => ({ type: 'removeNode' as const, nodeId: node.id })),
    ...nextNodes.map((node, index) => ({ type: 'addNode' as const, node, index })),
    ...nextEdges.map((edge) => ({ type: 'addEdge' as const, edge })),
    { type: 'updateSettings' as const, input: plan.input ?? current.input, defaults: plan.defaults ?? current.defaults },
  ];
}

function applyOperations(current: StoredWorkflowDefinition, operations: WorkflowEditOperation[]): StoredWorkflowDefinition {
  const next = normalizeDefinition(current);
  for (const operation of operations) {
    switch (operation.type) {
      case 'addNode':
        if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > next.nodes.length) throw new BadRequestException('The node insertion position is invalid.');
        if (next.nodes.some((node) => node.id === operation.node.id)) throw new BadRequestException('The node identifier already exists.');
        next.nodes.splice(operation.index, 0, structuredClone(operation.node));
        break;
      case 'removeNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new BadRequestException('The node to remove was not found.');
        next.nodes.splice(index, 1);
        next.edges = next.edges.filter((edge) => edge.sourceNodeId !== operation.nodeId && edge.targetNodeId !== operation.nodeId);
        break;
      }
      case 'updateNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new BadRequestException('The node to update was not found.');
        next.nodes[index] = { ...next.nodes[index], ...structuredClone(operation.patch) };
        break;
      }
      case 'moveNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new BadRequestException('The node to move was not found.');
        next.nodes[index] = { ...next.nodes[index], position: structuredClone(operation.position) };
        break;
      }
      case 'addEdge':
        if (next.edges.some((edge) => edge.id === operation.edge.id)) throw new BadRequestException('The edge identifier already exists.');
        next.edges.push(structuredClone(operation.edge));
        break;
      case 'removeEdge': {
        const index = next.edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw new BadRequestException('The edge to remove was not found.');
        next.edges.splice(index, 1);
        break;
      }
      case 'updateSettings':
        if (operation.input !== undefined) next.input = structuredClone(operation.input);
        if (operation.defaults !== undefined) next.defaults = structuredClone(operation.defaults);
        break;
    }
  }
  return next;
}

function validateDefinition(definition: StoredWorkflowDefinition, requireCompleteAgents: boolean): void {
  if (definition.schemaVersion !== 4) throw new BadRequestException('Workflow schema version 4 is required.');
  if (!definition.input || !definition.defaults || !['stop', 'retry'].includes(definition.defaults.errorPolicy) || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new BadRequestException('The workflow definition is invalid.');
  const ids = new Set<string>();
  const capabilities = new Map(listWorkflowNodeCapabilities().map((capability) => [`${capability.id}@${capability.version}`, capability]));
  if (definition.nodes.filter((node) => node.type === 'worklite/timer').length > 1) throw new BadRequestException('A Workflow can contain only one Timer node.');
  if (definition.nodes.filter((node) => node.type === 'worklite/dashboard').length > 1) throw new BadRequestException('A Workflow can contain only one Dashboard node.');
  const enabledTimer = definition.nodes.some((node) => node.type === 'worklite/timer' && isRecord(node.config) && node.config.enabled === true);
  const publishesToWechat = definition.nodes.some((node) => node.type === 'wechat-official-account/publish' && isRecord(node.config) && node.config.mode === 'publish');
  if (enabledTimer && publishesToWechat) throw new BadRequestException('Scheduled Workflows can save WeChat drafts but cannot require publication confirmation.');
  definition.nodes.forEach((node) => {
    if (!node.id || ids.has(node.id) || !node.type || !node.typeVersion || !['stop', 'retry'].includes(node.errorPolicy) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new BadRequestException('The workflow contains an invalid node.');
    const capability = capabilities.get(`${node.type}@${node.typeVersion}`);
    if (!capability) throw new BadRequestException(`The node type ${node.type}@${node.typeVersion} is not supported.`);
    validateNodeConfig(node.config, capability, node.type, requireCompleteAgents);
    ids.add(node.id);
  });

  const edgeIds = new Set<string>();
  const incomingEdges = new Map<string, StoredWorkflowDefinition['edges']>();
  for (const edge of definition.edges) {
    const source = definition.nodes.find((node) => node.id === edge.sourceNodeId);
    const target = definition.nodes.find((node) => node.id === edge.targetNodeId);
    const sourceCapability = source ? capabilities.get(`${source.type}@${source.typeVersion}`) : undefined;
    const targetCapability = target ? capabilities.get(`${target.type}@${target.typeVersion}`) : undefined;
    const sourcePort = sourceCapability?.outputs.find((port) => port.name === edge.sourcePort);
    const targetPort = targetCapability?.inputs.find((port) => port.name === edge.targetPort);
    const inputKey = `${edge.targetNodeId}:${edge.targetPort}`;
    if (!edge.id || edgeIds.has(edge.id)) throw new BadRequestException('The workflow contains a duplicate edge identifier.');
    if (!source || !target) throw new BadRequestException('A workflow edge references an unavailable node.');
    if (source.id === target.id) throw new BadRequestException('A workflow node cannot connect to itself.');
    if (!sourcePort || !targetPort) throw new BadRequestException('The workflow edge references an unavailable port.');
    if (!portsCompatible(sourcePort, targetPort)) throw new BadRequestException('The workflow edge connects incompatible ports.');
    if (!isGeneratedImageConnectionAllowed(source, target, edge.sourcePort, edge.targetPort)) throw new BadRequestException('Generated image output may connect only to the WeChat v2 coverImage input.');
    if (definition.edges.some((candidate) => candidate.id !== edge.id && candidate.sourceNodeId === edge.sourceNodeId && candidate.sourcePort === edge.sourcePort && candidate.targetNodeId === edge.targetNodeId && candidate.targetPort === edge.targetPort)) throw new BadRequestException('The workflow contains a duplicate connection.');
    validateEdgeControlFlow(edge);
    edgeIds.add(edge.id);
    const portEdges = incomingEdges.get(inputKey) ?? [];
    portEdges.push(edge);
    incomingEdges.set(inputKey, portEdges);
  }
  validateIncomingEdges(definition, capabilities, incomingEdges);

  if (requireCompleteAgents) {
    for (const node of definition.nodes) {
      const capability = capabilities.get(`${node.type}@${node.typeVersion}`);
      for (const port of capability?.inputs ?? []) {
        if (port.required && !definition.edges.some((edge) => edge.targetNodeId === node.id && edge.targetPort === port.name)) throw new BadRequestException(`Every required ${port.name} input must be connected before publication.`);
      }
    }
  }

  try {
    validateWorkflowControlFlow(definition);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'The workflow graph is invalid.');
  }
}


const WORKFLOW_EDGE_OPERATORS = new Set([
  'equals',
  'notEquals',
  'truthy',
  'falsy',
  'exists',
  'notExists',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
]);

function validateIncomingEdges(
  definition: StoredWorkflowDefinition,
  capabilities: Map<string, WorkflowNodeCapability>,
  incomingEdges: Map<string, StoredWorkflowDefinition['edges']>,
): void {
  for (const [inputKey, edges] of incomingEdges) {
    const [targetNodeId, targetPortName] = inputKey.split(':');
    const target = definition.nodes.find((node) => node.id === targetNodeId);
    const capability = target ? capabilities.get(`${target.type}@${target.typeVersion}`) : undefined;
    const targetPort = capability?.inputs.find((port) => port.name === targetPortName);
    if (!target || !targetPort || targetPort.multiple) continue;

    const inputEdges = edges.filter((edge) => definition.nodes.some((node) => node.id === edge.sourceNodeId && node.type === 'worklite/input'));
    const isAgentContext = target.type === 'worklite/agent' && targetPortName === 'context';
    if (isAgentContext && inputEdges.some((edge) => edge.condition !== undefined || edge.maxTraversals !== undefined)) throw new BadRequestException('A Workflow Input edge must be unconditional and unbounded.');
    if (inputEdges.length > 1) throw new BadRequestException('A workflow input port accepts only one Workflow Input edge.');
    if (edges.length === 1) continue;
    // Cardinality is the author's decision: the scheduler queues tokens per port, so converging
    // branches that carry conditions deliver one token and run the target once, while two
    // unconditional sources deliberately run it twice. Only the Agent context initial-plus-feedback
    // pair keeps a fixed shape, because a second unbounded edge there would race the loop token.
    const unboundedEdges = edges.filter((edge) => edge.maxTraversals === undefined);
    const feedbackEdges = edges.filter((edge) => edge.maxTraversals !== undefined);
    if (feedbackEdges.length === 0) continue;
    if (!isAgentContext) throw new BadRequestException('Only an Agent context port accepts a bounded feedback edge alongside another incoming edge.');
    if (feedbackEdges.length !== 1 || unboundedEdges.length !== 1 || inputEdges.length > 1) {
      throw new BadRequestException('Agent context may combine one initial edge with one bounded feedback edge.');
    }
  }
}

function validateEdgeControlFlow(edge: StoredWorkflowDefinition['edges'][number]): void {
  if (edge.maxTraversals !== undefined && (!Number.isInteger(edge.maxTraversals) || edge.maxTraversals < 1)) throw new BadRequestException('Workflow edge maximum traversals must be a positive integer.');
  if (edge.condition === undefined) return;
  if (!isRecord(edge.condition) || (edge.condition.kind !== 'predicate' && edge.condition.kind !== 'fallback')) throw new BadRequestException('Workflow edge condition kind must be predicate or fallback.');
  if (edge.condition.kind === 'fallback') {
    if ('path' in edge.condition || 'operator' in edge.condition || 'value' in edge.condition) throw new BadRequestException('Fallback workflow edges cannot define predicate fields.');
    return;
  }
  if (typeof edge.condition.path !== 'string' || !/^(?:\$|\$\.[^.\s]+(?:\.[^.\s]+)*|(?!\$)[^.\s]+(?:\.[^.\s]+)*)$/.test(edge.condition.path.trim())) throw new BadRequestException('Workflow edge predicate path must be a dot-delimited output path.');
  if (typeof edge.condition.operator !== 'string' || !WORKFLOW_EDGE_OPERATORS.has(edge.condition.operator)) throw new BadRequestException('Workflow edge predicate operator is not supported.');
  const requiresValue = workflowEdgeRequiresComparisonValue(edge.condition.operator);
  if (requiresValue && !('value' in edge.condition)) throw new BadRequestException('The workflow edge predicate operator requires a comparison value.');
  if (!requiresValue && 'value' in edge.condition) throw new BadRequestException('The workflow edge predicate operator cannot define a comparison value.');
}

function validateNodeConfig(value: unknown, capability: WorkflowNodeCapability, type: string, requireCompleteAgents: boolean): void {
  if (!isRecord(value)) throw new BadRequestException(`${capability.name} node configuration must be an object.`);
  const required = Array.isArray(capability.configSchema.required) ? capability.configSchema.required.filter((key): key is string => typeof key === 'string') : [];
  const allowedMissing = type === 'worklite/agent' && !requireCompleteAgents ? new Set(['model', 'systemPrompt']) : new Set<string>();
  for (const key of required) {
    if (allowedMissing.has(key)) continue;
    if (!(key in value)) throw new BadRequestException(`${capability.name} node configuration is missing ${key}.`);
  }
  const properties = isRecord(capability.configSchema.properties) ? capability.configSchema.properties : {};
  for (const [key, schema] of Object.entries(properties)) {
    if (!(key in value)) continue;
    validateSchemaValue(value[key], schema, `${capability.name} node ${key}`);
  }
  if (type === 'worklite/agent') {
    if (value.systemPrompt !== undefined && typeof value.systemPrompt !== 'string') throw new BadRequestException('Agent node systemPrompt must be a string.');
    if (value.outputFormat !== undefined && value.outputFormat !== 'text' && value.outputFormat !== 'json') throw new BadRequestException('Agent node outputFormat must be text or json.');
    if (value.outputContract !== undefined) {
      if (!Array.isArray(value.outputContract) || value.outputContract.length === 0 || value.outputContract.some((key) => typeof key !== 'string' || !key.trim())) throw new BadRequestException('Agent node outputContract must be a non-empty array of non-empty key names.');
      const names = (value.outputContract as string[]).map((key) => key.trim());
      if (new Set(names).size !== names.length) throw new BadRequestException('Agent node outputContract must not repeat a key name.');
      if (value.outputFormat !== 'json') throw new BadRequestException('Agent node outputContract requires outputFormat json.');
    }
    for (const key of ['maxToolCalls', 'maxToolRounds', 'maxToolResultChars']) {
      if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 1)) throw new BadRequestException(`Agent node ${key} must be a positive integer.`);
    }
    if (value.passthroughKeys !== undefined) {
      if (!Array.isArray(value.passthroughKeys) || !value.passthroughKeys.length || value.passthroughKeys.some((key) => typeof key !== 'string' || !key.trim()) || new Set(value.passthroughKeys).size !== value.passthroughKeys.length) throw new BadRequestException('Agent node passthroughKeys must be unique non-empty key names.');
      if (value.outputFormat !== 'json') throw new BadRequestException('Agent node passthroughKeys requires outputFormat json.');
    }
    if (requireCompleteAgents && (typeof value.model !== 'string' || !/^[^/]+\/.+/.test(value.model.trim()))) throw new BadRequestException('Every Agent node must contain a public provider/model id before publication.');
  }
  if (type === 'worklite/artifact') {
    if (typeof value.name !== 'string' || !value.name.trim()) throw new BadRequestException('Artifact node name must be a non-empty string.');
    if (value.type !== 'text' && value.type !== 'markdown' && value.type !== 'json') throw new BadRequestException('Artifact node type must be text, markdown, or json.');
  }
  if (type === 'worklite/artifact-query') {
    if (typeof value.name !== 'string' || !value.name.trim()) throw new BadRequestException('Artifact Query name must be a non-empty string.');
    if (typeof value.titleField !== 'string' || !value.titleField.trim()) throw new BadRequestException('Artifact Query title field must be a non-empty string.');
    if (!Array.isArray(value.descriptionFields) || value.descriptionFields.length === 0 || value.descriptionFields.some((field) => typeof field !== 'string' || !field.trim())) throw new BadRequestException('Artifact Query description fields must be non-empty strings.');
  }
  if (type === 'worklite/image') {
    if (value.model !== 'codex/gpt-image-2') throw new BadRequestException('Image node model must be codex/gpt-image-2.');
    if (typeof value.n !== 'number' || !Number.isInteger(value.n) || value.n < 1) throw new BadRequestException('Image node image count must be a positive integer.');
    if (value.background !== 'opaque' && value.background !== 'transparent') throw new BadRequestException('Image node background must be opaque or transparent.');
    if (value.quality !== 'low' && value.quality !== 'medium' && value.quality !== 'high') throw new BadRequestException('Image node quality must be low, medium, or high.');
    if (value.size !== '1024x1024' && value.size !== '1536x1024' && value.size !== '1024x1536') throw new BadRequestException('Image node size is not supported.');
  }
  if (type === 'worklite/timer') {
    if (typeof value.enabled !== 'boolean') throw new BadRequestException('Timer node enabled must be a boolean.');
    if (typeof value.intervalSeconds !== 'number' || !Number.isFinite(value.intervalSeconds) || value.intervalSeconds < 300) throw new BadRequestException('Timer node intervalSeconds must be a finite number of at least 300.');
  }
  if (type === 'worklite/dashboard') {
    if (!isRecord(value.layout)) throw new BadRequestException('Dashboard node layout must be an object.');
    for (const region of ['header', 'main', 'footer'] as const) {
      if (!Array.isArray(value.layout[region])) throw new BadRequestException(`Dashboard node layout ${region} must be an array.`);
      value.layout[region].forEach((element, index) => validateDashboardElement(element, `Dashboard node layout ${region} element ${index + 1}`));
    }
  }
}

function validateDashboardElement(value: unknown, label: string): void {
  if (!isRecord(value)) throw new BadRequestException(`${label} must be an object.`);
  if (value.kind === 'text') {
    if (typeof value.text !== 'string' || !value.text.trim()) throw new BadRequestException(`${label} text must be a non-empty string.`);
    return;
  }
  if (value.kind === 'count') {
    if (typeof value.label !== 'string' || !value.label.trim()) throw new BadRequestException(`${label} label must be a non-empty string.`);
    return;
  }
  if (value.kind === 'metric') {
    if (typeof value.label !== 'string' || !value.label.trim()) throw new BadRequestException(`${label} label must be a non-empty string.`);
    if (typeof value.field !== 'string' || !value.field.trim()) throw new BadRequestException(`${label} field must be a non-empty string.`);
    if (value.type !== 'text' && value.type !== 'number' && value.type !== 'boolean' && value.type !== 'datetime') throw new BadRequestException(`${label} type is not supported.`);
    return;
  }
  if (value.kind === 'list') {
    if (typeof value.titleKey !== 'string' || !value.titleKey.trim()) throw new BadRequestException(`${label} titleKey must be a non-empty string.`);
    if (!Array.isArray(value.fields)) throw new BadRequestException(`${label} fields must be an array.`);
    const fieldKeys = new Set<string>();
    value.fields.forEach((field, fieldIndex) => {
      const fieldLabel = `${label} field ${fieldIndex + 1}`;
      if (!isRecord(field)) throw new BadRequestException(`${fieldLabel} must be an object.`);
      if (typeof field.key !== 'string' || !field.key.trim()) throw new BadRequestException(`${fieldLabel} key must be a non-empty string.`);
      if (typeof field.label !== 'string' || !field.label.trim()) throw new BadRequestException(`${fieldLabel} label must be a non-empty string.`);
      if (field.type !== 'text' && field.type !== 'number' && field.type !== 'boolean' && field.type !== 'datetime' && field.type !== 'url') throw new BadRequestException(`${fieldLabel} type is not supported.`);
      if (fieldKeys.has(field.key)) throw new BadRequestException(`${label} field keys must be unique.`);
      fieldKeys.add(field.key);
    });
    if (!fieldKeys.has(value.titleKey)) throw new BadRequestException(`${label} titleKey must match a configured field key.`);
    return;
  }
  throw new BadRequestException(`${label} kind is not supported.`);
}

function validateSchemaValue(value: unknown, schema: unknown, label: string): void {
  if (!isRecord(schema) || schema.type === undefined) return;
  if (schema.type === 'string' && typeof value !== 'string') throw new BadRequestException(`${label} must be a string.`);
  if (schema.type === 'object' && !isRecord(value)) throw new BadRequestException(`${label} must be an object.`);
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new BadRequestException(`${label} must be an array.`);
    if (schema.items) value.forEach((item) => validateSchemaValue(item, schema.items, label));
  }
}

function portsCompatible(source: WorkflowPortDefinition, target: WorkflowPortDefinition): boolean {
  return source.dataType === target.dataType || source.dataType === 'json' || target.dataType === 'json';
}

function isGeneratedImageConnectionAllowed(
  source: StoredWorkflowDefinition['nodes'][number],
  target: StoredWorkflowDefinition['nodes'][number],
  sourcePort: string,
  targetPort: string,
): boolean {
  const isImageOutput = source.type === 'worklite/image' && source.typeVersion === '1' && sourcePort === 'output';
  const isWeChatCoverInput = target.type === 'wechat-official-account/publish' && target.typeVersion === '2' && targetPort === 'coverImage';
  return isImageOutput === isWeChatCoverInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toVersionView(row: typeof workflowVersions.$inferSelect): WorkflowVersionView {
  const definition = row.definition as StoredWorkflowDefinition | null;
  if (!definition) throw new BadRequestException('Workflow schema version 4 is required.');
  validateDefinition(definition, false);
  return { id: row.id, workflowId: row.workflowId, version: row.version, schemaVersion: definition.schemaVersion, definition: definition as WorkflowDefinition, sourceRevisionId: row.sourceRevisionId, publishedAt: (row.publishedAt ?? row.createdAt).toISOString(), publishedBy: row.publishedBy ?? 'You' };
}

function readDashboardBinding(definition: StoredWorkflowDefinition): WorkflowDashboardBinding | null {
  const node = definition.nodes.find((item) => item.type === 'worklite/dashboard');
  const config = node && isRecord(node.config) ? node.config : null;
  const layout = config && isRecord(config.layout) ? config.layout : null;
  if (!node || !config || !layout) return null;
  const readRegion = (value: unknown): WorkflowDashboardElement[] => Array.isArray(value) ? value.flatMap((element) => readDashboardElement(element)) : [];
  return {
    nodeId: node.id,
    layout: {
      header: readRegion(layout.header),
      main: readRegion(layout.main),
      footer: readRegion(layout.footer),
    },
  };
}

function readDashboardElement(value: unknown): WorkflowDashboardElement[] {
  if (!isRecord(value)) return [];
  if (value.kind === 'text' && typeof value.text === 'string') return [{ kind: 'text', text: value.text }];
  if (value.kind === 'count' && typeof value.label === 'string') return [{ kind: 'count', label: value.label }];
  if (value.kind === 'metric' && typeof value.label === 'string' && typeof value.field === 'string' && (value.type === 'text' || value.type === 'number' || value.type === 'boolean' || value.type === 'datetime')) {
    return [{ kind: 'metric', label: value.label, field: value.field, type: value.type }];
  }
  if (value.kind === 'list' && typeof value.titleKey === 'string' && Array.isArray(value.fields)) {
    const fields = value.fields.flatMap((field): WorkflowDashboardField[] => {
      if (!isRecord(field) || typeof field.key !== 'string' || typeof field.label !== 'string' || (field.type !== 'text' && field.type !== 'number' && field.type !== 'boolean' && field.type !== 'datetime')) return [];
      return [{ key: field.key, label: field.label, type: field.type }];
    });
    return [{ kind: 'list', titleKey: value.titleKey, fields }];
  }
  return [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];
}

function collectWorkflowResourceIds(definition: StoredWorkflowDefinition, key: 'skillIds' | 'mcpServerIds'): string[] {
  return [...new Set(definition.nodes.flatMap((node) => node.type === 'worklite/agent' && isRecord(node.config) ? readStringArray(node.config[key]) : []))];
}


function readPortableNames(value: unknown, resource: string): string[] {
  if (!Array.isArray(value)) throw new BadRequestException(`Every imported Agent node must contain portable ${resource} references.`);
  const names = value.map((item) => isRecord(item) && typeof item.name === 'string' ? item.name.trim() : '');
  if (names.some((name) => !name)) throw new BadRequestException(`Every imported ${resource} reference must contain a name.`);
  return names;
}

function resolvePortableNames(names: string[], rows: { id: string; name: string }[], resource: string): string[] {
  return names.map((name) => {
    const matches = rows.filter((row) => row.name === name);
    if (matches.length !== 1) throw new BadRequestException(`${resource} ${name} is missing or ambiguous in this workspace.`);
    return matches[0].id;
  });
}
