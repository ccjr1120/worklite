import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  AgentTeamRole,
  AgentTeamRoleConfiguration,
  AgentTeamRunEvent,
  AgentTeamRunView,
  AgentTeamRunSummary,
  AgentTeamView,
  AnswerAgentTeamRunRequest,
  CreateAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
  UpdateAgentTeamRequest,
} from '@worklite/contracts';
import {
  agentTeams,
  agentTeamRuns,
  mcpServers,
  skillFiles,
  skills,
  type AgentTeam,
  type Database,
  type StoredAgentTeamRoleConfiguration,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { PROJECT_EXECUTOR_PROTOCOLS } from '../agents/project-executor.types';
import {
  AGENT_TEAM_ROLES,
  AGENT_TEAM_ROLE_TOOL_NAMES,
  agentTeamEntryPoints,
} from './agent-team-configuration';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';

const ROLE_CONFIGURATION_KEYS = [
  'role',
  'publicModelId',
  'instructions',
  'entryPoints',
  'skillIds',
  'mcpServerIds',
  'toolNames',
  'executor',
] as const;

@Injectable()
export class AgentTeamsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly resources: WorkspaceResourcesService,
    private readonly runtime: AgentTeamRuntimeService,
  ) {}

  async get(request: Request, workspaceSlug: string, teamId: string): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return toTeamView(await this.getTeam(teamId, workspace.id));
  }

  async update(
    request: Request,
    workspaceSlug: string,
    teamId: string,
    input: UpdateAgentTeamRequest,
  ): Promise<AgentTeamView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const team = await this.getTeam(teamId, workspace.id);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'roles')) {
      throw new BadRequestException('Only Agent Team roles can be changed.');
    }
    if (input.roles === undefined) throw new BadRequestException('Agent Team roles are required.');
    const configuredRoles = await this.resolveRoles(workspace.id, input.roles);
    const [updated] = await this.db.update(agentTeams).set({
      roles: configuredRoles,
      updatedAt: new Date(),
    }).where(and(eq(agentTeams.id, team.id), eq(agentTeams.workspaceId, workspace.id))).returning();
    if (!updated) throw new NotFoundException('Agent Team not found.');
    return toTeamView(updated);
  }

  async records(request: Request, workspaceSlug: string, teamId: string): Promise<AgentTeamRunSummary[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(teamId, workspace.id);
    const rows = await this.db.select({ id: agentTeamRuns.id, intent: agentTeamRuns.intent,
      projectDirectory: agentTeamRuns.projectDirectory, mode: agentTeamRuns.mode,
      status: agentTeamRuns.status, createdAt: agentTeamRuns.createdAt, finishedAt: agentTeamRuns.finishedAt,
    }).from(agentTeamRuns).where(and(eq(agentTeamRuns.teamId, teamId), eq(agentTeamRuns.workspaceId, workspace.id)))
      .orderBy(desc(agentTeamRuns.createdAt));
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null }));
  }

  async createRun(
    request: Request,
    workspaceSlug: string,
    teamId: string,
    input: CreateAgentTeamRunRequest,
    acceptance: Parameters<AgentTeamRuntimeService['createRun']>[2],
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.getTeam(teamId, workspace.id);
    return this.runtime.createRun(workspace.id, input, acceptance);
  }

  async getRun(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.runtime.getRunView(runId, workspace.id);
  }

  async events(
    request: Request,
    workspaceSlug: string,
    runId: string,
    afterSequence: number,
  ): Promise<AgentTeamRunEvent[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.runtime.getRunEvents(runId, workspace.id, afterSequence);
  }

  subscribe(listener: (event: AgentTeamRunEvent) => void): () => void {
    return this.runtime.subscribe(listener);
  }

  async answer(
    request: Request,
    workspaceSlug: string,
    runId: string,
    input: AnswerAgentTeamRunRequest,
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.answer(runId, input);
  }

  async recover(
    request: Request,
    workspaceSlug: string,
    runId: string,
    input: RecoverAgentTeamOperationRequest,
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.recover(runId, input);
  }

  async pause(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.pause(runId);
  }

  async resume(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.resume(runId);
  }

  async cancel(request: Request, workspaceSlug: string, runId: string): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.cancel(runId);
  }

  async retry(
    request: Request,
    workspaceSlug: string,
    runId: string,
    taskKey: string,
  ): Promise<AgentTeamRunView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.runtime.getRunView(runId, workspace.id);
    return this.runtime.retry(runId, taskKey);
  }

  private async getTeam(teamId: string, workspaceId: string): Promise<AgentTeam> {
    const [team] = await this.db.select().from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Agent Team not found.');
    return team;
  }

  private async resolveRoles(
    workspaceId: string,
    values: AgentTeamRoleConfiguration[],
  ): Promise<StoredAgentTeamRoleConfiguration[]> {
    if (!Array.isArray(values) || values.length !== AGENT_TEAM_ROLES.length) {
      throw new BadRequestException('Every supported Agent Team role is required exactly once.');
    }
    const byRole = new Map<AgentTeamRole, AgentTeamRoleConfiguration>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException('Every Agent Team role configuration must be an object.');
      }
      if (Object.keys(value).some((key) => !(ROLE_CONFIGURATION_KEYS as readonly string[]).includes(key))) {
        throw new BadRequestException('An Agent Team role configuration contains an unsupported field.');
      }
      const role = value.role;
      if (!AGENT_TEAM_ROLES.includes(role) || byRole.has(role)) {
        throw new BadRequestException('Every supported Agent Team role is required exactly once.');
      }
      byRole.set(role, value);
    }

    const normalized: Array<Omit<StoredAgentTeamRoleConfiguration, 'skills' | 'mcpServers'>> = [];
    for (const role of AGENT_TEAM_ROLES) {
      const value = byRole.get(role);
      if (!value) throw new BadRequestException('Every supported Agent Team role is required exactly once.');
      if (typeof value.publicModelId !== 'string') {
        throw new BadRequestException(`A public model id for Agent Team role ${role} must be a string.`);
      }
      const publicModelId = value.publicModelId.trim();
      if (value.executor !== undefined && (role !== 'developer' || (value.executor !== 'claude' && value.executor !== 'codex'))) {
        throw new BadRequestException('Only the developer role selects an executor, which must be claude or codex.');
      }
      const executor = role === 'developer' ? value.executor ?? 'claude' : undefined;
      const runtime = publicModelId ? await this.resources.publicModelRuntime(workspaceId, publicModelId) : undefined;
      if (executor && runtime && !PROJECT_EXECUTOR_PROTOCOLS[executor].includes(runtime.protocol)) {
        throw new BadRequestException(`The developer model must use ${PROJECT_EXECUTOR_PROTOCOLS[executor].join(' or ')} for the ${executor} executor.`);
      }
      if (typeof value.instructions !== 'string' || !value.instructions.trim()) {
        throw new BadRequestException(`Instructions for Agent Team role ${role} are required.`);
      }
      const instructions = value.instructions.trim();
      const entryPoints = normalizeStrings(value.entryPoints, `entry points for Agent Team role ${role}`);
      const allowedEntryPoints = agentTeamEntryPoints(role);
      if (entryPoints.some((entryPoint) => !allowedEntryPoints.includes(entryPoint))) {
        throw new BadRequestException(`An entry point is not supported for Agent Team role ${role}.`);
      }
      const toolNames = normalizeStrings(value.toolNames, `tool names for Agent Team role ${role}`);
      const allowedToolNames = AGENT_TEAM_ROLE_TOOL_NAMES[role];
      if (toolNames.some((toolName) => !allowedToolNames.includes(toolName))) {
        throw new BadRequestException(`A tool is not supported for Agent Team role ${role}.`);
      }

      normalized.push({
        role,
        publicModelId,
        instructions,
        entryPoints,
        toolNames,
        ...(executor ? { executor } : {}),
      });
    }

    const skillIds = new Set(values.flatMap((value) => uniqueStrings(value.skillIds, `Skill ids for Agent Team role ${value.role}`)));
    const mcpServerIds = new Set(values.flatMap((value) => uniqueStrings(value.mcpServerIds, `MCP server ids for Agent Team role ${value.role}`)));
    const skillSnapshots = await this.resolveSkills(workspaceId, skillIds);
    const mcpSnapshots = await this.resolveMcpServers(workspaceId, mcpServerIds);
    const skillsByRole = new Map(values.map((value) => [value.role, uniqueStrings(value.skillIds, `Skill ids for Agent Team role ${value.role}`)]));
    const mcpServersByRole = new Map(values.map((value) => [value.role, uniqueStrings(value.mcpServerIds, `MCP server ids for Agent Team role ${value.role}`)]));
    return normalized.map((role) => ({
      ...role,
      skills: skillsByRole.get(role.role)?.flatMap((id) => skillSnapshots.get(id) ? [skillSnapshots.get(id)!] : []) ?? [],
      mcpServers: mcpServersByRole.get(role.role)?.flatMap((id) => mcpSnapshots.get(id) ? [mcpSnapshots.get(id)!] : []) ?? [],
    }));
  }

  private async resolveSkills(
    workspaceId: string,
    skillIds: ReadonlySet<string>,
  ): Promise<Map<string, StoredAgentTeamRoleConfiguration['skills'][number]>> {
    const rows = skillIds.size === 0
      ? []
      : await this.db.select().from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, [...skillIds])));
    if (rows.length !== skillIds.size) throw new NotFoundException('A selected Skill was not found in this workspace.');
    const files = rows.length === 0
      ? []
      : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    return new Map(rows.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      files: files.filter((file) => file.skillId === row.id).map((file) => ({ path: file.path, content: file.content })),
    }]));
  }

  private async resolveMcpServers(
    workspaceId: string,
    serverIds: ReadonlySet<string>,
  ): Promise<Map<string, StoredAgentTeamRoleConfiguration['mcpServers'][number]>> {
    const rows = serverIds.size === 0
      ? []
      : await this.db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, [...serverIds])));
    if (rows.length !== serverIds.size) throw new NotFoundException('A selected MCP server was not found in this workspace.');
    return new Map(rows.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      allowedToolNames: row.allowedToolNames ?? [],
    }]));
  }
}

function toTeamView(row: AgentTeam): AgentTeamView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    processId: row.processId,
    processVersion: row.processVersion,
    // Stored roles predating orchestration v3 may still carry the removed
    // developerInstances/developerConcurrency fields; reads drop them and the
    // next save persists the clean shape.
    roles: row.roles.map((role) => ({
      role: role.role,
      publicModelId: role.publicModelId,
      instructions: role.instructions,
      entryPoints: role.entryPoints,
      skillIds: role.skills.map((skill) => skill.id),
      mcpServerIds: role.mcpServers.map((server) => server.id),
      toolNames: role.toolNames,
      ...(role.role === 'developer' ? { executor: role.executor ?? 'claude' } : {}),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new BadRequestException(`${label} must be an array.`);
  const result = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new BadRequestException(`${label} must contain non-empty strings.`);
    return item.trim();
  });
  if (new Set(result).size !== result.length) throw new BadRequestException(`${label} must be unique.`);
  return result;
}

function normalizeStrings(value: unknown, label: string): string[] {
  return uniqueStrings(value, label);
}

