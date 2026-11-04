import { validatePrivateTools } from './agent-private-tools';
import { resolveWorkflowNodeCapability } from '@worklite/workflow-engine';
import type { AgentCollaboration } from '@worklite/contracts';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import type { AgentView, CreateAgentRequest, ModelProviderView, UpdateAgentRequest } from '@worklite/contracts';
import { CHAT_TURN_NOTIFICATION_DEFAULT_SOUND, CHAT_TURN_NOTIFICATION_SOUNDS, WORKLITE_PLATFORM_SKILL_NAME } from '@worklite/contracts';
import { agentExecutions, chatConfigurations, agentMcpServers, agentVersions, agents, agentSkills, mcpServers, scheduledAgentTasks, skills, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkspaceService } from '../teams/teams.service';

import { validateAgentRuntime } from './agent-runtime.configuration';

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
    await this.resources.reconcileWorkspaceSkills(team.id);
    const rows = await this.db.select({ agent: agents }).from(agents).where(and(eq(agents.workspaceId, team.id), eq(agents.kind, 'custom')));
    const gatewayNames = await this.gatewayProviderNames();
    const assignments = await this.loadAssignments(team.id, rows.map(({ agent }) => agent.id));
    return rows
      .sort((left, right) => left.agent.name.localeCompare(right.agent.name))
      .map(({ agent }) => this.toView(agent, workspaceSlug, agent.providerId ? gatewayNames.get(agent.providerId) ?? null : null, assignments));
  }

  async get(request: Request, workspaceSlug: string, agentId: string): Promise<AgentView> {
    if (agentId === CODEX_CLI_AGENT_ID) throw new NotFoundException('Agent not found');
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.resources.reconcileWorkspaceSkills(team.id);
    const [row] = await this.db.select({ agent: agents }).from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Agent not found');
    const gatewayNames = await this.gatewayProviderNames();
    const assignments = await this.loadAssignments(team.id, [row.agent.id]);
    const view = this.toView(row.agent, workspaceSlug, row.agent.providerId ? gatewayNames.get(row.agent.providerId) ?? null : null, assignments);
    if (agentId === CHAT_AGENT_ID) {
      const [configuration] = await this.db.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, team.id)).orderBy(desc(chatConfigurations.revision)).limit(1);
      if (configuration) view.chatConfiguration = { revision: configuration.revision, extensionPrompt: configuration.extensionPrompt, summarizePrompt: configuration.summarizePrompt, turnNotificationsEnabled: configuration.turnNotificationsEnabled, turnNotificationSound: configuration.turnNotificationSound, skillIds: configuration.skillIds };
    }
    return view;
  }

  async create(request: Request, workspaceSlug: string, input: CreateAgentRequest): Promise<AgentView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.resources.reconcileWorkspaceSkills(team.id);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Agent name is required.');
    const responsibility = input.responsibility?.trim() ?? '';
    const systemPrompt = input.systemPrompt?.trim() ?? '';
    const providerId = input.providerId ?? null;
    const model = input.model?.trim() ?? '';
    const collaboration = await this.validateCollaboration(team.id, input.collaboration ?? null, input.parentAgentId);
    const runtime = await validateAgentRuntime(input.runtime);
    if (runtime.kind !== 'native' && ((collaboration?.subAgentIds.length ?? 0) > 0 || (collaboration?.capabilities.length ?? 0) > 0 || (collaboration?.privateTools?.length ?? 0) > 0)) throw new BadRequestException('Use a native lead Agent to coordinate sub-Agents and capability tools.');
    if ((!collaboration?.publicModels?.length && runtime.kind === 'native') || providerId) await this.validateModel(team.id, providerId, model);
    const validatedAssignments = await this.validateAssignments(team.id, input.skillIds, input.mcpServerIds);
    const skillIds = validatedAssignments.skillIds ?? [];
    const mcpServerIds = validatedAssignments.mcpServerIds ?? [];
    const id = `agt_${randomUUID()}`;
    await this.db.transaction((transaction) => {
      const parent = input.parentAgentId ? transaction.select().from(agents).where(and(eq(agents.id, input.parentAgentId), eq(agents.workspaceId, team.id), eq(agents.kind, 'custom'))).get() : undefined;
      if (input.parentAgentId && (!parent || parent.runtime.kind !== 'native')) throw new BadRequestException('The parent must be an available native Agent.');
      const [row] = transaction.insert(agents).values({ id, workspaceId: team.id, kind: 'custom', name, responsibility, systemPrompt, providerId, model, runtime, collaboration }).returning({ id: agents.id }).all();
      if (!row) throw new NotFoundException('Agent could not be created');
      if (skillIds.length > 0) transaction.insert(agentSkills).values(skillIds.map((skillId) => ({ agentId: id, skillId }))).run();
      if (mcpServerIds.length > 0) transaction.insert(agentMcpServers).values(mcpServerIds.map((mcpServerId) => ({ agentId: id, mcpServerId }))).run();
      if (parent) transaction.update(agents).set({ collaboration: { ...parent.collaboration, subAgentIds: [...(parent.collaboration?.subAgentIds ?? []), id], capabilities: parent.collaboration?.capabilities ?? [] }, updatedAt: new Date() }).where(eq(agents.id, parent.id)).run();
    });
    return this.get(request, workspaceSlug, id);
  }

  async update(request: Request, workspaceSlug: string, agentId: string, input: UpdateAgentRequest): Promise<AgentView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.resources.reconcileWorkspaceSkills(team.id);
    const [existing] = await this.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Agent not found');

    if (existing.kind === 'system') {

      const isChat = existing.id === CHAT_AGENT_ID;
        // Chat Skills are captured from its revisioned configuration. User MCP servers remain unavailable to Chat.
        const fields = ['providerId', 'model', ...(isChat ? ['skillIds', 'extensionPrompt', 'summarizePrompt', 'turnNotificationsEnabled', 'turnNotificationSound', 'expectedConfigurationRevision'] : ['mcpServerIds'])];
        if (isChat && 'mcpServerIds' in input) throw new BadRequestException('Chat does not accept user MCP server selections.');
      if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('Unsupported Chat configuration field.');
      const nextProviderId = input.providerId === undefined ? existing.providerId : input.providerId;
      const provider = await this.validateProvider(team.id, nextProviderId);
      const requestedModel = input.model === undefined ? existing.model.trim() : input.model.trim();
      if (provider && requestedModel && !provider.models.includes(requestedModel)) throw new BadRequestException('The selected model is not configured for this provider.');
      const model = provider ? requestedModel || provider.models[0] || '' : '';
      if (input.extensionPrompt !== undefined && typeof input.extensionPrompt !== 'string') throw new BadRequestException('An extension prompt must be text.');
      if (input.summarizePrompt !== undefined && typeof input.summarizePrompt !== 'string') throw new BadRequestException('A summarize prompt must be text.');
      if (input.turnNotificationsEnabled !== undefined && typeof input.turnNotificationsEnabled !== 'boolean') throw new BadRequestException('The conversation notification switch must be true or false.');
      // A sound name reaches the macOS notification command as a quoted literal; only the names macOS
      // accepts are stored, and an empty name means a silent notification.
      if (input.turnNotificationSound !== undefined && (typeof input.turnNotificationSound !== 'string' || (input.turnNotificationSound.trim() !== '' && !CHAT_TURN_NOTIFICATION_SOUNDS.includes(input.turnNotificationSound.trim())))) throw new BadRequestException(`A conversation notification sound must be empty or one of: ${CHAT_TURN_NOTIFICATION_SOUNDS.join(', ')}.`);
        const selections = await this.validateAssignments(team.id, isChat ? input.skillIds : undefined, input.mcpServerIds, true);
        const chatSkillIds = isChat ? selections.skillIds : undefined;
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
          turnNotificationsEnabled: input.turnNotificationsEnabled ?? previous?.turnNotificationsEnabled ?? true,
          turnNotificationSound: input.turnNotificationSound === undefined ? previous?.turnNotificationSound ?? CHAT_TURN_NOTIFICATION_DEFAULT_SOUND : input.turnNotificationSound.trim(),
          providerId: nextProviderId ?? null, model,
          skillIds: chatSkillIds ?? previous?.skillIds ?? [],
          mcpServerIds: [],
        }).run();
      });
      return this.get(request, workspaceSlug, agentId);
    }

    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new BadRequestException('Agent name is required.');
    const nextProviderId = input.providerId === undefined ? existing.providerId : input.providerId;
    const model = input.model === undefined ? existing.model : input.model.trim();
    const collaboration = await this.validateCollaboration(team.id, input.collaboration === undefined ? existing.collaboration : input.collaboration, agentId);
    const runtime = await validateAgentRuntime(input.runtime === undefined ? existing.runtime : input.runtime);
    if (runtime.kind !== 'native' && ((collaboration?.subAgentIds.length ?? 0) > 0 || (collaboration?.capabilities.length ?? 0) > 0 || (collaboration?.privateTools?.length ?? 0) > 0)) throw new BadRequestException('Use a native lead Agent to coordinate sub-Agents and capability tools.');
    if ((!collaboration?.publicModels?.length && runtime.kind === 'native') || nextProviderId) await this.validateModel(team.id, nextProviderId, model);
    const assignments = await this.validateAssignments(team.id, input.skillIds, input.mcpServerIds, true);

    await this.db.transaction((transaction) => {
      const [row] = transaction.update(agents).set({
        name,
        runtime,
        collaboration,
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
    if (existing.kind === 'system') throw new BadRequestException('The Chat entry point cannot be deleted.');
    const parents = await this.db.select().from(agents).where(eq(agents.workspaceId, team.id));
    if (parents.some((parent) => parent.collaboration?.subAgentIds.includes(agentId))) throw new ConflictException('Remove this sub-Agent from its parent before deleting it.');
    const active = await this.db.select({ id: agentExecutions.id }).from(agentExecutions).where(and(eq(agentExecutions.agentId, agentId), inArray(agentExecutions.status, ['running', 'waiting_for_input']))).limit(1);
    if (active.length) throw new ConflictException('Cancel the active Agent execution before deleting it.');
    await this.db.transaction((transaction) => {
      transaction.delete(scheduledAgentTasks).where(and(eq(scheduledAgentTasks.agentId, agentId), eq(scheduledAgentTasks.workspaceId, team.id))).run();
      transaction.delete(agentExecutions).where(and(eq(agentExecutions.agentId, agentId), eq(agentExecutions.workspaceId, team.id))).run();
      transaction.delete(agentSkills).where(eq(agentSkills.agentId, agentId)).run();
      transaction.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run();
      transaction.delete(agentVersions).where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.workspaceId, team.id))).run();
      transaction.delete(agents).where(and(eq(agents.id, agentId), eq(agents.workspaceId, team.id))).run();
    });
  }

  private async validateCollaboration(workspaceId: string, value: unknown, agentId?: string): Promise<AgentCollaboration | null> {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Agent collaboration must be an object or null.');
    const config = value as AgentCollaboration;
    if (!Array.isArray(config.subAgentIds) || config.subAgentIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(config.subAgentIds).size !== config.subAgentIds.length) throw new BadRequestException('subAgentIds must contain unique Agent ids.');
    if (!Array.isArray(config.capabilities)) throw new BadRequestException('capabilities must be an array.');
    const controls = ['worklite/agent', 'worklite/map', 'worklite/input', 'worklite/timer', 'worklite/branch', 'worklite/join', 'worklite/dashboard'];
    const ids = new Set<string>();
    for (const capability of config.capabilities) {
      if (!capability || typeof capability.id !== 'string' || !capability.id.trim() || ids.has(capability.id) || controls.includes(capability.type) || !resolveWorkflowNodeCapability(capability.type, capability.typeVersion) || !capability.config || typeof capability.config !== 'object' || Array.isArray(capability.config)) throw new BadRequestException('An Agent capability is invalid or duplicated.');
      ids.add(capability.id);
    }
    await validatePrivateTools(config);
    if (config.publicModels !== undefined && (!Array.isArray(config.publicModels) || config.publicModels.some((model) => typeof model !== 'string' || !model.includes('/')))) throw new BadRequestException('publicModels must contain public provider/model ids.');
    if (config.builtinToolNames !== undefined && (!Array.isArray(config.builtinToolNames) || config.builtinToolNames.some((name) => !['bash', 'read', 'write', 'glob', 'grep'].includes(name)))) throw new BadRequestException('An Agent built-in tool is invalid.');
    if (config.outputFormat !== undefined && !['text', 'json'].includes(config.outputFormat)) throw new BadRequestException('outputFormat must be text or json.');
    if (config.requiredSkillIds !== undefined && (!Array.isArray(config.requiredSkillIds) || config.requiredSkillIds.some((id) => typeof id !== 'string'))) throw new BadRequestException('requiredSkillIds must be an array of Skill ids.');
    for (const limit of Object.values(config.limits ?? {})) if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) throw new BadRequestException('Agent limits must be positive integers.');
    const directory = await this.db.select().from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.kind, 'custom')));
    const byId = new Map(directory.map((agent) => [agent.id, agent]));
    const visit = (id: string, ancestors: string[]) => {
      if (id === agentId || ancestors.includes(id)) throw new BadRequestException('Sub-Agent assignments cannot contain cycles.');
      const child = byId.get(id);
      if (!child) throw new BadRequestException('Sub-Agents must be Agents from this workspace.');
      for (const descendant of child.collaboration?.subAgentIds ?? []) visit(descendant, [...ancestors, id]);
    };
    for (const id of config.subAgentIds) visit(id, []);
    return config;
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

  private async validateModel(workspaceId: string, providerId: string | null | undefined, model: string): Promise<{ name: string; models: string[] } | null> {
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
        ? this.db.select({ id: skills.id, name: skills.name, validation: skills.validation, validationReason: skills.validationReason }).from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, skillIds)))
        : Promise.resolve([]),
      mcpServerIds && mcpServerIds.length > 0
        ? this.db.select({ id: mcpServers.id }).from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, mcpServerIds)))
        : Promise.resolve([]),
    ]);
    if (skillIds && skillRows.length !== skillIds.length) throw new BadRequestException('One or more selected Skills are not available in this workspace.');
    if (skillRows.some((skill) => skill.name === WORKLITE_PLATFORM_SKILL_NAME)) throw new BadRequestException('The worklite-platform Skill is reserved for Chat.');
    const invalidSkill = skillRows.find((skill) => skill.validation !== 'valid');
    if (invalidSkill) throw new BadRequestException(invalidSkill.validationReason ?? `Skill ${invalidSkill.name} is invalid.`);
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

  private toView(row: typeof agents.$inferSelect, workspaceSlug: string, providerName: string | null, assignments: AgentAssignments): AgentView {
    return {
      id: row.id,
      workspaceSlug,
      kind: row.kind,
      runtime: row.runtime,
      collaboration: row.collaboration,
      name: row.name,
      responsibility: row.responsibility,
      systemPrompt: row.systemPrompt,
      initials: initials(row.name),
      model: row.model,
      providerId: row.providerId,
      providerName,
      // Chat exposes only its protected platform Skill; legacy Chat Skill/MCP assignment rows are not shown.
      skills: (assignments.skillsByAgent.get(row.id) ?? []).filter((skill) => row.id !== CHAT_AGENT_ID || skill.name === WORKLITE_PLATFORM_SKILL_NAME),
      mcpServers: row.id === CHAT_AGENT_ID ? [] : assignments.mcpServersByAgent.get(row.id) ?? [],
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function normalizeResourceIds(input: unknown, resourceName: string): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) throw new BadRequestException(`${resourceName} selections must be an array of identifiers.`);
  return [...new Set(input.map((value) => value.trim()).filter(Boolean))];
}
