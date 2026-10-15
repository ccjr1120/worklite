import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentVersionView, AgentView, CreateAgentRequest, ModelProviderView, UpdateAgentRequest } from '@worklite/contracts';
import { agentExecutions, chatConfigurations, agentMcpServers, agentVersions, agents, agentSkills, mcpServers, scheduledAgentTasks, skills, type Database, type StoredProjectExecutor } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkspaceService } from '../teams/teams.service';
import { PROJECT_EXECUTOR_PROTOCOLS } from './project-executor.types';

const WORKLITE_PLATFORM_SKILL_ID = 'sk_worklite_platform';
const CHAT_AGENT_ID = 'agt_system_helper_chat';
const CODEX_CLI_AGENT_ID = 'agt_codex_cli_chat';
const GATEWAY_PORT = Number(process.env.PORTKEY_GATEWAY_PORT ?? 23392);
const GATEWAY_PROVIDER_URL = `http://127.0.0.1:${GATEWAY_PORT}/worklite/providers`;

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

type AgentAssignments = {
  skillsByAgent: Map<string, AgentView['skills']>;
  mcpServersByAgent: Map<string, AgentView['mcpServers']>;
};

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async list(request: Request, workspaceSlug: string): Promise<AgentView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ agent: agents }).from(agents).where(and(eq(agents.workspaceId, team.id), ne(agents.id, CODEX_CLI_AGENT_ID)));
    const gatewayNames = await this.gatewayProviderNames();
    const assignments = await this.loadAssignments(team.id, rows.map(({ agent }) => agent.id));
    const latestRows = rows.length === 0 ? [] : await this.db.select({ agentId: agentVersions.agentId, id: agentVersions.id, version: agentVersions.version }).from(agentVersions).where(and(eq(agentVersions.workspaceId, team.id), inArray(agentVersions.agentId, rows.map(({ agent }) => agent.id)))).orderBy(desc(agentVersions.version));
    const latestByAgent = new Map<string, { id: string; version: number }>();
    for (const row of latestRows) if (!latestByAgent.has(row.agentId)) latestByAgent.set(row.agentId, { id: row.id, version: row.version });
    return rows
      .sort((left, right) => Number(left.agent.kind !== 'system') - Number(right.agent.kind !== 'system') || left.agent.name.localeCompare(right.agent.name))
      .map(({ agent }) => this.toView(agent, workspaceSlug, agent.providerId ? gatewayNames.get(agent.providerId) ?? null : null, assignments, latestByAgent.get(agent.id)));
  }

  async get(request: Request, workspaceSlug: string, agentId: string): Promise<AgentView> {
    if (agentId === CODEX_CLI_AGENT_ID) throw new NotFoundException('Agent not found');
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select({ agent: agents }).from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Agent not found');
    const gatewayNames = await this.gatewayProviderNames();
    const assignments = await this.loadAssignments(team.id, [row.agent.id]);
    const [latest] = await this.db.select({ id: agentVersions.id, version: agentVersions.version }).from(agentVersions).where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.workspaceId, team.id))).orderBy(desc(agentVersions.version)).limit(1);
    const view = this.toView(row.agent, workspaceSlug, row.agent.providerId ? gatewayNames.get(row.agent.providerId) ?? null : null, assignments, latest);
    if (agentId === CHAT_AGENT_ID) {
      const [configuration] = await this.db.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, team.id)).orderBy(desc(chatConfigurations.revision)).limit(1);
      if (configuration) view.chatConfiguration = { revision: configuration.revision, extensionPrompt: configuration.extensionPrompt, summarizePrompt: configuration.summarizePrompt, defaultExecutor: configuration.defaultExecutor, defaultExecutorModels: configuration.defaultExecutorModels, projectTaskMcpServerIds: configuration.projectTaskMcpServerIds };
    }
    return view;
  }

  async create(request: Request, workspaceSlug: string, input: CreateAgentRequest): Promise<AgentView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Agent name is required.');
    const responsibility = input.responsibility?.trim() ?? '';
    const systemPrompt = input.systemPrompt?.trim() ?? '';
    const providerId = input.providerId ?? null;
    const model = input.model?.trim() ?? '';
    await this.validateDraftModel(team.id, providerId, model);
    const validatedAssignments = await this.validateAssignments(team.id, input.skillIds, input.mcpServerIds);
    const skillIds = validatedAssignments.skillIds ?? [];
    const mcpServerIds = validatedAssignments.mcpServerIds ?? [];
    const id = `agt_${randomUUID()}`;
    await this.db.transaction((transaction) => {
      const [row] = transaction.insert(agents).values({ id, workspaceId: team.id, kind: 'custom', name, responsibility, systemPrompt, providerId, model }).returning({ id: agents.id }).all();
      if (!row) throw new NotFoundException('Agent could not be created');
      if (skillIds.length > 0) transaction.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: id, skillId }))).run();
      if (mcpServerIds.length > 0) transaction.insert(agentMcpServers).values(mcpServerIds.map((mcpServerId) => ({ agentId: id, mcpServerId }))).run();
    });
    return this.get(request, workspaceSlug, id);
  }

  async versions(request: Request, workspaceSlug: string, agentId: string): Promise<AgentVersionView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [agent] = await this.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!agent) throw new NotFoundException('Agent not found');
    const rows = await this.db.select().from(agentVersions).where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.workspaceId, team.id))).orderBy(desc(agentVersions.version));
    return rows.map(toAgentVersionView);
  }

  async createVersion(request: Request, workspaceSlug: string, agentId: string): Promise<AgentVersionView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!agent) throw new NotFoundException('Agent not found');
    if (!agent.providerId || !agent.model) throw new BadRequestException('Configure a model provider and model before publishing an Agent version.');
    const assignments = await Promise.all([
      this.db.select({ id: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, agentId)),
      this.db.select({ id: agentMcpServers.mcpServerId }).from(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)),
    ]);
    const row = this.db.transaction((transaction) => {
      const [latest] = transaction.select({ version: agentVersions.version }).from(agentVersions).where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.workspaceId, team.id))).orderBy(desc(agentVersions.version)).limit(1).all();
      const [created] = transaction.insert(agentVersions).values({
        id: `agv_${randomUUID()}`,
        workspaceId: team.id,
        agentId: agent.id,
        version: (latest?.version ?? 0) + 1,
        name: agent.name,
        responsibility: agent.responsibility,
        systemPrompt: agent.systemPrompt,
        providerId: agent.providerId,
        model: agent.model,
        skillIds: assignments[0].map(({ id }) => id),
        mcpServerIds: assignments[1].map(({ id }) => id),
      }).returning().all();
      return created;
    });
    if (!row) throw new NotFoundException('Agent version could not be created');
    return toAgentVersionView(row);
  }

  async version(request: Request, workspaceSlug: string, versionId: string): Promise<AgentVersionView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Agent version not found');
    return toAgentVersionView(row);
  }

  async update(request: Request, workspaceSlug: string, agentId: string, input: UpdateAgentRequest): Promise<AgentView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Agent not found');

    if (existing.kind === 'system') {

      const isChat = existing.id === CHAT_AGENT_ID;
      // Chat configuration has no Skill/MCP selection; its legacy assignment rows are retained but never rewritten.
      const fields = ['providerId', 'model', ...(isChat ? ['extensionPrompt', 'summarizePrompt', 'defaultExecutor', 'defaultExecutorModels', 'projectTaskMcpServerIds', 'expectedConfigurationRevision'] : ['mcpServerIds'])];
      if (isChat && ('skillIds' in input || 'mcpServerIds' in input)) throw new BadRequestException('Chat configuration no longer accepts Skill or MCP server selections.');
      if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('Unsupported built-in Agent configuration field.');
      const nextProviderId = input.providerId === undefined ? existing.providerId : input.providerId;
      const provider = await this.validateProvider(team.id, nextProviderId);
      const requestedModel = input.model === undefined ? existing.model.trim() : input.model.trim();
      if (provider && requestedModel && !provider.models.includes(requestedModel)) throw new BadRequestException('The selected model is not configured for this provider.');
      const model = provider ? requestedModel || provider.models[0] || '' : '';
      if (input.extensionPrompt !== undefined && typeof input.extensionPrompt !== 'string') throw new BadRequestException('An extension prompt must be text.');
      if (input.summarizePrompt !== undefined && typeof input.summarizePrompt !== 'string') throw new BadRequestException('A summarize prompt must be text.');
      if (input.defaultExecutor !== undefined && input.defaultExecutor !== 'claude' && input.defaultExecutor !== 'codex') throw new BadRequestException('The default executor must be claude or codex.');
      // Declared per-executor default models merge into the stored declarations; every declared model must
      // speak the protocol its executor supports, including declarations kept from the previous revision.
      const executorModelsPatch = input.defaultExecutorModels === undefined ? undefined : parseExecutorModelsPatch(input.defaultExecutorModels);
      let mergedExecutorModels: Partial<Record<StoredProjectExecutor, string>> | undefined;
      if (executorModelsPatch !== undefined) {
        const [latest] = await this.db.select({ models: chatConfigurations.defaultExecutorModels }).from(chatConfigurations).where(eq(chatConfigurations.workspaceId, team.id)).orderBy(desc(chatConfigurations.revision)).limit(1);
        mergedExecutorModels = mergeExecutorModels(latest?.models, executorModelsPatch);
        for (const executor of ['claude', 'codex'] as const) {
          const declared = mergedExecutorModels[executor];
          if (!declared) continue;
          const runtime = await this.resources.publicModelRuntime(team.id, declared);
          if (!PROJECT_EXECUTOR_PROTOCOLS[executor].includes(runtime.protocol)) throw new BadRequestException(`${executor === 'codex' ? 'Codex' : 'Claude Code'} 需要 ${PROJECT_EXECUTOR_PROTOCOLS[executor].join(' 或 ')} 协议的 Gateway 模型。`);
        }
      }
      const selections = await this.validateAssignments(team.id, undefined, input.mcpServerIds, true);
      // MCP servers declared for Claude Code project tasks are validated against the workspace like any selection.
      const projectTaskMcpServerIds = isChat && input.projectTaskMcpServerIds !== undefined
        ? (await this.validateAssignments(team.id, undefined, input.projectTaskMcpServerIds)).mcpServerIds
        : undefined;
      this.db.transaction((transaction) => {
        const [previous] = transaction.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, team.id)).orderBy(desc(chatConfigurations.revision)).limit(1).all();
        if (isChat && input.expectedConfigurationRevision !== undefined && input.expectedConfigurationRevision !== previous?.revision) throw new ConflictException('Chat configuration changed; inspect the current revision before updating.');
        transaction.update(agents).set({ providerId: nextProviderId ?? null, model, updatedAt: new Date() }).where(eq(agents.id, agentId)).run();
        if (selections.mcpServerIds !== undefined) {
          transaction.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run();
          if (selections.mcpServerIds.length) transaction.insert(agentMcpServers).values(selections.mcpServerIds.map((mcpServerId) => ({ agentId, mcpServerId }))).run();
        }
        if (isChat) transaction.insert(chatConfigurations).values({
          workspaceId: team.id, revision: (previous?.revision ?? 0) + 1,
          extensionPrompt: input.extensionPrompt === undefined ? previous?.extensionPrompt ?? '' : input.extensionPrompt,
          summarizePrompt: input.summarizePrompt === undefined ? previous?.summarizePrompt ?? '' : input.summarizePrompt,
          defaultExecutor: input.defaultExecutor ?? previous?.defaultExecutor ?? 'claude',
          defaultExecutorModels: executorModelsPatch === undefined ? previous?.defaultExecutorModels ?? {} : mergeExecutorModels(previous?.defaultExecutorModels, executorModelsPatch),
          projectTaskMcpServerIds: projectTaskMcpServerIds ?? previous?.projectTaskMcpServerIds ?? [],
          providerId: nextProviderId ?? null, model,
          skillIds: [WORKLITE_PLATFORM_SKILL_ID],
          mcpServerIds: [],
        }).run();
      });
      return this.get(request, workspaceSlug, agentId);
    }

    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new BadRequestException('Agent name is required.');
    const nextProviderId = input.providerId === undefined ? existing.providerId : input.providerId;
    const model = input.model === undefined ? existing.model : input.model.trim();
    await this.validateDraftModel(team.id, nextProviderId, model);
    const assignments = await this.validateAssignments(team.id, input.skillIds, input.mcpServerIds, true);

    await this.db.transaction((transaction) => {
      const [row] = transaction.update(agents).set({
        name,
        ...(input.responsibility === undefined ? {} : { responsibility: input.responsibility.trim() }),
        ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt.trim() }),
        providerId: nextProviderId ?? null,
        model,
        updatedAt: new Date(),
      }).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).returning({ id: agents.id }).all();
      if (!row) throw new NotFoundException('Agent not found');
      if (assignments.skillIds !== undefined) {
        transaction.delete(agentSkills).where(eq(agentSkills.agentId, agentId)).run();
        if (assignments.skillIds.length > 0) transaction.insert(agentSkills).values(assignments.skillIds.map((skillId) => ({ agentId, skillId }))).run();
      }
      if (assignments.mcpServerIds !== undefined) {
        transaction.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run();
        if (assignments.mcpServerIds.length > 0) transaction.insert(agentMcpServers).values(assignments.mcpServerIds.map((mcpServerId) => ({ agentId, mcpServerId }))).run();
      }
    });
    return this.get(request, workspaceSlug, agentId);
  }

  async delete(request: Request, workspaceSlug: string, agentId: string): Promise<void> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Agent not found');
    if (existing.kind === 'system') throw new BadRequestException('Built-in Agents cannot be deleted.');
    await this.db.transaction((transaction) => {
      transaction.delete(scheduledAgentTasks).where(and(eq(scheduledAgentTasks.agentId, agentId), eq(scheduledAgentTasks.workspaceId, team.id))).run();
      transaction.delete(agentExecutions).where(and(eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, team.id))).run();
      transaction.delete(agentSkills).where(eq(agentSkills.agentId, agentId)).run();
      transaction.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run();
      transaction.delete(agentVersions).where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.workspaceId, team.id))).run();
      transaction.delete(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).run();
    });
  }

  private async validateProvider(workspaceId: string, providerId: string | null | undefined): Promise<{ name: string; models: string[] } | null> {
    if (!providerId) return null;
    try {
      const response = await fetch(`${GATEWAY_PROVIDER_URL}/${encodeURIComponent(providerId)}`);
      if (response.ok) {
        const gatewayProvider = await response.json() as Pick<ModelProviderView, 'name' | 'models'>;
        return { name: gatewayProvider.name, models: (gatewayProvider.models ?? []).map((model) => model.trim()).filter(Boolean) };
      }
    } catch {
      // Fall through to the stable domain error below.
    }
    throw new BadRequestException('Model provider not found in the Gateway.');
  }

  private async gatewayProviderNames(): Promise<Map<string, string>> {
    try {
      const response = await fetch(GATEWAY_PROVIDER_URL);
      if (!response.ok) return new Map();
      const providers = await response.json() as Array<Pick<ModelProviderView, 'id' | 'name'>>;
      return new Map(providers.map((provider) => [provider.id, provider.name]));
    } catch {
      return new Map();
    }
  }

  private async validateDraftModel(workspaceId: string, providerId: string | null | undefined, model: string): Promise<{ name: string; models: string[] } | null> {
    const provider = await this.validateProvider(workspaceId, providerId);
    if (!provider) {
      if (model) throw new BadRequestException('Select a model provider before selecting a model.');
      return null;
    }
    if (model && !provider.models.includes(model)) throw new BadRequestException('The selected model is not configured for this provider.');
    return provider;
  }

  private async validateAssignments(
    workspaceId: string,
    requestedSkillIds: string[] | undefined,
    requestedMcpServerIds: string[] | undefined,
    preserveMissing = false,
  ): Promise<{ skillIds: string[] | undefined; mcpServerIds: string[] | undefined }> {
    const skillIds = requestedSkillIds === undefined && preserveMissing ? undefined : normalizeResourceIds(requestedSkillIds, 'Skill');
    const mcpServerIds = requestedMcpServerIds === undefined && preserveMissing ? undefined : normalizeResourceIds(requestedMcpServerIds, 'MCP server');
    const [skillRows, mcpRows] = await Promise.all([
      skillIds && skillIds.length > 0
        ? this.db.select({ id: skills.id }).from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds)))
        : Promise.resolve([]),
      mcpServerIds && mcpServerIds.length > 0
        ? this.db.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, mcpServerIds)))
        : Promise.resolve([]),
    ]);
    if (skillIds && skillRows.length !== skillIds.length) throw new BadRequestException('One or more selected Skills are not available in this workspace.');
    if (skillRows.some((skill) => skill.id === WORKLITE_PLATFORM_SKILL_ID)) throw new BadRequestException('The worklite-platform Skill is reserved for Chat.');
    if (mcpServerIds && mcpRows.length !== mcpServerIds.length) throw new BadRequestException('One or more selected MCP servers are not available in this workspace.');
    return { skillIds, mcpServerIds };
  }

  private async loadAssignments(workspaceId: string, agentIds: string[]): Promise<AgentAssignments> {
    const skillsByAgent = new Map<string, AgentView['skills']>();
    const mcpServersByAgent = new Map<string, AgentView['mcpServers']>();
    if (agentIds.length === 0) return { skillsByAgent, mcpServersByAgent };
    const [skillRows, mcpRows] = await Promise.all([
      this.db.select({ agentId: agentSkills.agentId, id: skills.id, name: skills.name, version: skills.version, validation: skills.validation })
        .from(agentSkills)
        .innerJoin(skills, eq(agentSkills.skillId, skills.id))
        .where(and(eq(skills.workspaceId, workspaceId), inArray(agentSkills.agentId, agentIds))),
      this.db.select({ agentId: agentMcpServers.agentId, id: mcpServers.id, name: mcpServers.name, version: mcpServers.version, connection: mcpServers.connection, allowedTools: mcpServers.allowedTools })
        .from(agentMcpServers)
        .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
        .where(and(eq(mcpServers.workspaceId, workspaceId), inArray(agentMcpServers.agentId, agentIds))),
    ]);
    for (const { agentId, ...skill } of skillRows) skillsByAgent.set(agentId, [...(skillsByAgent.get(agentId) ?? []), skill]);
    for (const { agentId, ...server } of mcpRows) mcpServersByAgent.set(agentId, [...(mcpServersByAgent.get(agentId) ?? []), server]);
    return { skillsByAgent, mcpServersByAgent };
  }

  private toView(row: typeof agents.$inferSelect, workspaceSlug: string, providerName: string | null, assignments: AgentAssignments, latestVersion?: { id: string; version: number }): AgentView {
    return {
      id: row.id,
      workspaceSlug,
      kind: row.kind,
      name: row.name,
      responsibility: row.responsibility,
      systemPrompt: row.systemPrompt,
      initials: initials(row.name),
      model: row.model,
      providerId: row.providerId,
      providerName,
      // Chat exposes only its protected platform Skill; legacy Chat Skill/MCP assignment rows are not shown.
      skills: (assignments.skillsByAgent.get(row.id) ?? []).filter((skill) => row.id !== CHAT_AGENT_ID || skill.id === WORKLITE_PLATFORM_SKILL_ID),
      mcpServers: row.id === CHAT_AGENT_ID ? [] : assignments.mcpServersByAgent.get(row.id) ?? [],
      version: 'draft',
      latestVersionId: latestVersion?.id ?? null,
      latestVersion: latestVersion?.version ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function normalizeResourceIds(input: unknown, resourceName: string): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) throw new BadRequestException(`${resourceName} selections must be an array of identifiers.`);
  return [...new Set(input.map((value) => value.trim()).filter(Boolean))];
}

// A string declares a model, null or an empty string clears the declaration; other keys are rejected.
function parseExecutorModelsPatch(input: unknown): Partial<Record<StoredProjectExecutor, string | null>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Default executor models must be an object keyed by executor.');
  const patch: Partial<Record<StoredProjectExecutor, string | null>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'claude' && key !== 'codex') throw new BadRequestException('Default executor models must be keyed by claude or codex.');
    if (value === null || (typeof value === 'string' && !value.trim())) patch[key] = null;
    else if (typeof value === 'string') patch[key] = value.trim();
    else throw new BadRequestException('A default executor model must be a Gateway public model id or null.');
  }
  return patch;
}

function mergeExecutorModels(current: Partial<Record<StoredProjectExecutor, string>> | undefined, patch: Partial<Record<StoredProjectExecutor, string | null>>): Partial<Record<StoredProjectExecutor, string>> {
  const merged: Partial<Record<StoredProjectExecutor, string>> = { ...(current ?? {}) };
  for (const [executor, model] of Object.entries(patch) as Array<[StoredProjectExecutor, string | null]>) {
    if (model === null) delete merged[executor];
    else merged[executor] = model;
  }
  return merged;
}

function toAgentVersionView(row: typeof agentVersions.$inferSelect): AgentVersionView {
  return {
    id: row.id,
    agentId: row.agentId,
    version: row.version,
    name: row.name,
    responsibility: row.responsibility,
    systemPrompt: row.systemPrompt,
    providerId: row.providerId,
    model: row.model,
    skillIds: row.skillIds ?? [],
    mcpServerIds: row.mcpServerIds ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}
