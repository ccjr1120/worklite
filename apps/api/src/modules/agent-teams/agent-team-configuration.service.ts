import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AgentTeamRoleId, AgentTeamRoleConfiguration, UpdateAgentTeamRequest } from '@worklite/contracts';
import {
  agentTeams,
  mcpServers,
  skillFiles,
  skills,
  type AgentTeam,
  type Database,
  type StoredAgentTeamRoleConfiguration,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { PROJECT_EXECUTOR_PROTOCOLS } from '../agents/project-executor.types';
import {
  AGENT_TEAM_ROLE_TOOL_NAMES,
  agentTeamEntryPoints,
  isValidAgentTeamRoleId,
} from './agent-team-configuration';

const ROLE_CONFIGURATION_KEYS = [
  'role', 'displayName', 'publicModelId', 'instructions', 'entryPoints', 'skillIds', 'mcpServerIds', 'toolNames', 'executor',
] as const;
const CUSTOM_ROLE_TOOL_NAMES = ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'] as const;

@Injectable()
export class AgentTeamConfigurationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly resources: WorkspaceResourcesService,
  ) {}

  async getTeam(workspaceId: string, teamId: string): Promise<AgentTeam> {
    const [team] = await this.db.select().from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.workspaceId, workspaceId))).limit(1);
    if (!team) throw new NotFoundException('Agent Team not found.');
    return team;
  }

  async update(workspaceId: string, teamId: string, input: UpdateAgentTeamRequest): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, teamId);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['roles', 'maxConcurrentRuns', 'workingPractice'].includes(key))) {
      throw new BadRequestException('Only Agent Team roles, working practice and concurrency can be changed.');
    }
    if (input.roles === undefined && input.maxConcurrentRuns === undefined && input.workingPractice === undefined) {
      throw new BadRequestException('At least one Agent Team setting is required.');
    }
    const roles = input.roles === undefined ? team.roles : await this.resolveRoles(workspaceId, input.roles);
    if (input.maxConcurrentRuns !== undefined && (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns < 1)) {
      throw new BadRequestException('Maximum concurrent Team Runs must be an integer of at least 1.');
    }
    if (input.workingPractice !== undefined && typeof input.workingPractice !== 'string') {
      throw new BadRequestException('Team working practice must be text.');
    }
    const [updated] = await this.db.update(agentTeams).set({
      roles,
      ...(input.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: input.maxConcurrentRuns }),
      ...(input.workingPractice === undefined ? {} : { workingPractice: input.workingPractice.trim() }),
      updatedAt: new Date(),
    }).where(and(eq(agentTeams.id, team.id), eq(agentTeams.workspaceId, workspaceId))).returning();
    if (!updated) throw new NotFoundException('Agent Team not found.');
    return updated;
  }

  async createRole(workspaceId: string, teamId: string, input: Omit<AgentTeamRoleConfiguration, 'role'>, roleId?: string): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, teamId);
    const role = roleId ?? `role_${randomUUID()}`;
    if (team.roles.some((item) => item.role === role)) return team;
    return this.update(workspaceId, teamId, { roles: [...toPublicRoles(team.roles), { ...input, role }] });
  }

  async updateRole(
    workspaceId: string,
    teamId: string,
    roleId: string,
    changes: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>,
  ): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, teamId);
    const target = team.roles.find((role) => role.role === roleId);
    if (!target) throw new NotFoundException('Agent Team role not found.');
    const updated = { ...toPublicRole(target), ...changes, role: roleId };
    return this.update(workspaceId, teamId, {
      roles: team.roles.map((role) => role.role === roleId ? updated : toPublicRole(role)),
    });
  }

  async deleteRole(workspaceId: string, teamId: string, roleId: string): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, teamId);
    if (!team.roles.some((role) => role.role === roleId)) throw new NotFoundException('Agent Team role not found.');
    return this.update(workspaceId, teamId, { roles: team.roles.filter((role) => role.role !== roleId).map(toPublicRole) });
  }

  private async resolveRoles(workspaceId: string, values: AgentTeamRoleConfiguration[]): Promise<StoredAgentTeamRoleConfiguration[]> {
    if (!Array.isArray(values) || values.length < 1) throw new BadRequestException('At least one Agent Team role is required.');
    const byRole = new Map<AgentTeamRoleId, AgentTeamRoleConfiguration>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Every Agent Team role configuration must be an object.');
      if (Object.keys(value).some((key) => !(ROLE_CONFIGURATION_KEYS as readonly string[]).includes(key))) throw new BadRequestException('An Agent Team role configuration contains an unsupported field.');
      if (!isValidAgentTeamRoleId(value.role) || byRole.has(value.role)) throw new BadRequestException('Agent Team role ids must be unique lowercase identifiers.');
      byRole.set(value.role, value);
    }
    if (byRole.has('team-manager')) throw new BadRequestException('Team Manager is not an active work role.');

    const normalized: Array<Omit<StoredAgentTeamRoleConfiguration, 'skills' | 'mcpServers'>> = [];
    for (const [role, value] of byRole) {
      if (typeof value.publicModelId !== 'string') throw new BadRequestException(`A public model id for Agent Team role ${role} must be a string.`);
      const publicModelId = value.publicModelId.trim();
      if (value.executor !== undefined && value.executor !== null && value.executor !== 'claude' && value.executor !== 'codex') throw new BadRequestException(`The executor for Agent Team role ${role} must be claude or codex.`);
      const executor = role === 'developer' ? value.executor ?? 'claude' : value.executor ?? undefined;
      const runtime = publicModelId ? await this.resources.publicModelRuntime(workspaceId, publicModelId) : undefined;
      if (executor && runtime && !PROJECT_EXECUTOR_PROTOCOLS[executor].includes(runtime.protocol)) {
        throw new BadRequestException(`The ${role} model must use ${PROJECT_EXECUTOR_PROTOCOLS[executor].join(' or ')} for the ${executor} executor.`);
      }
      if (typeof value.instructions !== 'string' || !value.instructions.trim()) throw new BadRequestException(`Instructions for Agent Team role ${role} are required.`);
      const displayName = value.displayName === undefined ? undefined : value.displayName.trim();
      if (displayName !== undefined && !displayName) throw new BadRequestException(`The display name for Agent Team role ${role} is required.`);
      const builtIn = AGENT_TEAM_ROLE_TOOL_NAMES[role];
      if (!builtIn && !displayName) throw new BadRequestException(`A display name is required for custom Agent Team role ${role}.`);
      const entryPoints = normalizeStrings(value.entryPoints, `entry points for Agent Team role ${role}`);
      const allowedEntryPoints = agentTeamEntryPoints(role);
      if (entryPoints.some((entryPoint) => !allowedEntryPoints.includes(entryPoint))) throw new BadRequestException(`An entry point is not supported for Agent Team role ${role}.`);
      const toolNames = normalizeStrings(value.toolNames, `tool names for Agent Team role ${role}`);
      const allowedToolNames = builtIn ?? CUSTOM_ROLE_TOOL_NAMES;
      if (toolNames.some((toolName) => !allowedToolNames.includes(toolName as never))) throw new BadRequestException(`A tool is not supported for Agent Team role ${role}.`);
      normalized.push({ role, ...(displayName ? { displayName } : {}), publicModelId, instructions: value.instructions.trim(), entryPoints, toolNames, ...(executor ? { executor } : {}) });
    }

    const skillIds = new Set(values.flatMap((value) => uniqueStrings(value.skillIds, `Skill ids for Agent Team role ${value.role}`)));
    const mcpServerIds = new Set(values.flatMap((value) => uniqueStrings(value.mcpServerIds, `MCP server ids for Agent Team role ${value.role}`)));
    const skillSnapshots = await this.resolveSkills(workspaceId, skillIds);
    const mcpSnapshots = await this.resolveMcpServers(workspaceId, mcpServerIds);
    const skillsByRole = new Map(values.map((value) => [value.role, uniqueStrings(value.skillIds, `Skill ids for Agent Team role ${value.role}`)]));
    const mcpByRole = new Map(values.map((value) => [value.role, uniqueStrings(value.mcpServerIds, `MCP server ids for Agent Team role ${value.role}`)]));
    return normalized.map((role) => ({
      ...role,
      skills: skillsByRole.get(role.role)?.flatMap((id) => skillSnapshots.get(id) ? [skillSnapshots.get(id)!] : []) ?? [],
      mcpServers: mcpByRole.get(role.role)?.flatMap((id) => mcpSnapshots.get(id) ? [mcpSnapshots.get(id)!] : []) ?? [],
    }));
  }

  private async resolveSkills(workspaceId: string, skillIds: ReadonlySet<string>) {
    const rows = skillIds.size === 0 ? [] : await this.db.select().from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, [...skillIds])));
    if (rows.length !== skillIds.size) throw new NotFoundException('A selected Skill was not found in this workspace.');
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, files: files.filter((file) => file.skillId === row.id).map((file) => ({ path: file.path, content: file.content })) }]));
  }

  private async resolveMcpServers(workspaceId: string, serverIds: ReadonlySet<string>) {
    const rows = serverIds.size === 0 ? [] : await this.db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, [...serverIds])));
    if (rows.length !== serverIds.size) throw new NotFoundException('A selected MCP server was not found in this workspace.');
    // A role captures the server's discovered tool set, so a never-configured
    // server connects and discovers its tools here before the capture.
    const resolved = await Promise.all(rows.map((row) => row.connection === 'unconfigured' ? this.resources.autoConnectMcpServer(row, true) : row));
    return new Map(resolved.map((row) => [row.id, { id: row.id, name: row.name, allowedToolNames: row.allowedToolNames ?? [] }]));
  }
}

function toPublicRoles(roles: StoredAgentTeamRoleConfiguration[]): AgentTeamRoleConfiguration[] {
  return roles.map(toPublicRole);
}

function toPublicRole(role: StoredAgentTeamRoleConfiguration): AgentTeamRoleConfiguration {
  return {
    role: role.role,
    ...(role.displayName ? { displayName: role.displayName } : {}),
    publicModelId: role.publicModelId,
    instructions: role.instructions,
    entryPoints: role.entryPoints,
    skillIds: role.skills.map((skill) => skill.id),
    mcpServerIds: role.mcpServers.map((server) => server.id),
    toolNames: role.toolNames,
    ...(role.executor ? { executor: role.executor } : {}),
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
