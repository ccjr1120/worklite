import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AgentTeamRoleId, AgentTeamRoleConfiguration, CreateAgentTeamRequest, UpdateAgentTeamRequest } from '@worklite/contracts';
import {
  coders,
  coderRuns,
  mcpServers,
  skillFiles,
  skills,
  type AgentTeam,
  type Database,
  type StoredAgentTeamRoleConfiguration,
} from '@worklite/db';
import { normalizePublicModelList } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { PROJECT_EXECUTOR_PROTOCOLS } from '../agents/project-executor.types';
import {
  CODER_ROLE_TOOL_NAMES,
  CODER_DISPATCHER_ROLE,
  DIRECT_PLANNER_INSTRUCTIONS,
  DEFAULT_DIRECT_GIT_POLICY,
  CODER_PROCESS_ID,
  CODER_PROCESS_VERSION,
  CODER_ROLE_INSTRUCTIONS,
  RETIRED_AGENT_TEAM_IDS,
  agentTeamEntryPoints,
  isValidAgentTeamRoleId,
} from './coder-configuration';

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

  async getTeam(workspaceId: string, coderId: string): Promise<AgentTeam> {
    this.validateNotRetiredTeamId(coderId);
    await this.resources.reconcileWorkspaceSkills(workspaceId);
    const [team] = await this.db.select().from(coders)
      .where(and(eq(coders.id, coderId), eq(coders.workspaceId, workspaceId))).limit(1);
    if (!team) throw new NotFoundException('Coder not found.');
    return team;
  }

  private validateNotRetiredTeamId(coderId: string): void {
    if ((RETIRED_AGENT_TEAM_IDS as readonly string[]).includes(coderId)) {
      throw new BadRequestException(`This Coder (${coderId}) has been retired and is no longer available.`);
    }
  }

  async reconcileSkills(workspaceId: string): Promise<void> {
    await this.resources.reconcileWorkspaceSkills(workspaceId);
  }

  async create(workspaceId: string, input: CreateAgentTeamRequest): Promise<AgentTeam> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['name', 'description', 'templateCoderId'].includes(key))) throw new BadRequestException('Invalid Coder configuration.');
    const name = normalizeCoderName(input.name);
    if (input.description !== undefined && typeof input.description !== 'string') throw new BadRequestException('Coder description must be text.');
    if (input.templateCoderId !== undefined && (typeof input.templateCoderId !== 'string' || !input.templateCoderId.trim())) throw new BadRequestException('templateCoderId must be a non-empty Coder id.');
    const template = input.templateCoderId ? await this.getTeam(workspaceId, input.templateCoderId) : undefined;
    if (template?.deletedAt) throw new NotFoundException('Coder template not found.');
    const id = `coder_${randomUUID()}`;
    await this.assertCoderNameAvailable(workspaceId, id, name);
    const roles = template?.roles ?? [
      { role: 'planner', publicModelId: '', instructions: DIRECT_PLANNER_INSTRUCTIONS, entryPoints: [], skills: [], mcpServers: [], toolNames: [...CODER_ROLE_TOOL_NAMES.planner!] },
      { role: 'implementer', displayName: 'Implementer', publicModelId: '', instructions: CODER_ROLE_INSTRUCTIONS.implementer!, entryPoints: [], skills: [], mcpServers: [], toolNames: [...CODER_ROLE_TOOL_NAMES.implementer!], executor: 'claude' as const },
    ];
    try {
      const [created] = await this.db.insert(coders).values({ id, workspaceId, name, description: input.description?.trim() ?? template?.description ?? '', processId: template?.processId ?? CODER_PROCESS_ID, processVersion: template?.processVersion ?? CODER_PROCESS_VERSION, roles, workingPractice: template?.workingPractice ?? '', projectGitPolicy: template?.projectGitPolicy ?? DEFAULT_DIRECT_GIT_POLICY, maxConcurrentRuns: template?.maxConcurrentRuns ?? 3 }).returning();
      return created!;
    } catch (error) {
      if (isUniqueConstraintError(error)) throw coderNameConflict(name);
      throw error;
    }
  }

  async update(workspaceId: string, coderId: string, input: UpdateAgentTeamRequest): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, coderId);
    if (team.deletedAt) throw new ConflictException('This Coder has been deleted.');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['name', 'description', 'expectedRevision', 'roles', 'maxConcurrentRuns', 'workingPractice', 'projectGitPolicy'].includes(key))) {
      throw new BadRequestException('Only the Coder name, roles, working practice, project Git policy and concurrency can be changed.');
    }
    if (input.name === undefined && input.description === undefined && input.roles === undefined && input.maxConcurrentRuns === undefined && input.workingPractice === undefined && input.projectGitPolicy === undefined) {
      throw new BadRequestException('At least one Coder setting is required.');
    }
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
      throw new BadRequestException('expectedRevision must be the non-negative integer revision from the Coder view.');
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== coderRevision(team)) throw coderRevisionConflict();
    const name = input.name === undefined ? undefined : normalizeCoderName(input.name);
    if (input.description !== undefined && typeof input.description !== 'string') throw new BadRequestException('Coder description must be text.');
    if (name !== undefined && name !== team.name) await this.assertCoderNameAvailable(workspaceId, team.id, name);
    const roles = input.roles === undefined ? team.roles : await this.resolveRoles(workspaceId, input.roles);
    if (input.maxConcurrentRuns !== undefined && (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns < 1)) {
      throw new BadRequestException('Maximum concurrent Coder Runs must be an integer of at least 1.');
    }
    if (input.workingPractice !== undefined && typeof input.workingPractice !== 'string') {
      throw new BadRequestException('Coder working practice must be text.');
    }
    if (input.projectGitPolicy !== undefined && typeof input.projectGitPolicy !== 'string') {
      throw new BadRequestException('Coder project Git policy must be text.');
    }
    let updated: AgentTeam | undefined;
    try {
      [updated] = await this.db.update(coders).set({
        roles,
        ...(name === undefined ? {} : { name }),
        ...(input.description === undefined ? {} : { description: input.description.trim() }),
        ...(input.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: input.maxConcurrentRuns }),
        ...(input.workingPractice === undefined ? {} : { workingPractice: input.workingPractice.trim() }),
        ...(input.projectGitPolicy === undefined ? {} : { projectGitPolicy: input.projectGitPolicy.trim() }),
        // The revision is updatedAt in milliseconds, so every write must move it forward.
        updatedAt: new Date(Math.max(Date.now(), coderRevision(team) + 1)),
      }).where(and(
        eq(coders.id, team.id),
        eq(coders.workspaceId, workspaceId),
        // Compare-and-set on the revision read above, so a concurrent write is never overwritten.
        eq(coders.updatedAt, team.updatedAt),
      )).returning();
    } catch (error) {
      if (isUniqueConstraintError(error)) throw coderNameConflict(name ?? team.name);
      throw error;
    }
    if (!updated) {
      const [current] = await this.db.select({ id: coders.id }).from(coders)
        .where(and(eq(coders.id, team.id), eq(coders.workspaceId, workspaceId))).limit(1);
      if (!current) throw new NotFoundException('Coder not found.');
      throw coderRevisionConflict();
    }
    return updated;
  }

  private async assertCoderNameAvailable(workspaceId: string, coderId: string, name: string): Promise<void> {
    const [duplicate] = await this.db.select({ id: coders.id }).from(coders)
      .where(and(
        eq(coders.workspaceId, workspaceId),
        isNull(coders.deletedAt),
        ne(coders.id, coderId),
        sql`lower(${coders.name}) = lower(${name})`,
      )).limit(1);
    if (duplicate) throw coderNameConflict(name);
  }

  async createRole(workspaceId: string, coderId: string, input: Omit<AgentTeamRoleConfiguration, 'role'>, roleId?: string): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, coderId);
    if (team.deletedAt) throw new ConflictException('This Coder has been deleted.');
    const role = roleId ?? `role_${randomUUID()}`;
    if (team.roles.some((item) => item.role === role)) return team;
    return this.update(workspaceId, coderId, { roles: [...toPublicRoles(team.roles), { ...input, role }] });
  }

  async updateRole(
    workspaceId: string,
    coderId: string,
    roleId: string,
    changes: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>,
  ): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, coderId);
    if (team.deletedAt) throw new ConflictException('This Coder has been deleted.');
    const target = team.roles.find((role) => role.role === roleId);
    if (!target) throw new NotFoundException('Coder role not found.');
    const updated = { ...toPublicRole(target), ...changes, role: roleId };
    return this.update(workspaceId, coderId, {
      roles: team.roles.map((role) => role.role === roleId ? updated : toPublicRole(role)),
    });
  }

  async deleteRole(workspaceId: string, coderId: string, roleId: string): Promise<AgentTeam> {
    const team = await this.getTeam(workspaceId, coderId);
    if (team.deletedAt) throw new ConflictException('This Coder has been deleted.');
    if (!team.roles.some((role) => role.role === roleId)) throw new NotFoundException('Coder role not found.');
    const remainingRoles = team.roles.filter((role) => role.role !== roleId);
    const hasDispatcher = remainingRoles.some((role) => role.role === CODER_DISPATCHER_ROLE);
    const hasPlanner = remainingRoles.some((role) => role.role === 'planner');
    if (!hasDispatcher && !hasPlanner) {
      throw new BadRequestException('A Dispatcher or Planner role is required as the Coder entry role.');
    }
    return this.update(workspaceId, coderId, { roles: remainingRoles.map(toPublicRole) });
  }

  private async resolveRoles(workspaceId: string, values: AgentTeamRoleConfiguration[]): Promise<StoredAgentTeamRoleConfiguration[]> {
    if (!Array.isArray(values) || values.length < 1) throw new BadRequestException('At least one Coder role is required.');
    const byRole = new Map<AgentTeamRoleId, AgentTeamRoleConfiguration>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Every Coder role configuration must be an object.');
      if (Object.keys(value).some((key) => !(ROLE_CONFIGURATION_KEYS as readonly string[]).includes(key))) throw new BadRequestException('A Coder role configuration contains an unsupported field.');
      if (!isValidAgentTeamRoleId(value.role) || byRole.has(value.role)) throw new BadRequestException('Coder role ids must be unique lowercase identifiers.');
      byRole.set(value.role, value);
    }
    if (byRole.has('executor-manager')) throw new BadRequestException('Executor Manager is not an active work role.');
    const hasDispatcher = byRole.has(CODER_DISPATCHER_ROLE);
    const hasPlanner = byRole.has('planner');
    if (!hasDispatcher && !hasPlanner) {
      throw new BadRequestException('A Dispatcher or Planner role is required as the Coder entry role.');
    }

    const normalized: Array<Omit<StoredAgentTeamRoleConfiguration, 'skills' | 'mcpServers'>> = [];
    for (const [role, value] of byRole) {
      if (typeof value.publicModelId !== 'string' && (!Array.isArray(value.publicModelId) || value.publicModelId.some((id) => typeof id !== 'string'))) {
        throw new BadRequestException(`A public model id for Coder role ${role} must be a string or an array of strings.`);
      }
      const publicModelIds = normalizePublicModelList(value.publicModelId);
      // A single empty string keeps the historical "use the role/executor default" meaning; an
      // array is always a declared fallback list, with its first candidate taking that role.
      const publicModelId: string | string[] = Array.isArray(value.publicModelId) ? publicModelIds : (publicModelIds[0] ?? '');
      if (value.executor !== undefined && value.executor !== null && value.executor !== 'claude' && value.executor !== 'codex') throw new BadRequestException(`The executor for Coder role ${role} must be claude or codex.`);
      const executor = role === 'developer' ? value.executor ?? 'claude' : value.executor ?? undefined;
      // A role's publicModelId is always a Gateway public id, so every declared candidate must speak a
      // protocol its executor can reach through the Gateway (Claude Code: anthropic/messages, Codex:
      // openai or codex responses).
      const protocols = executor ? PROJECT_EXECUTOR_PROTOCOLS[executor] : undefined;
      for (const candidateModelId of publicModelIds) {
        const runtime = await this.resources.publicModelRuntime(workspaceId, candidateModelId);
        if (executor && protocols && !protocols.includes(runtime.protocol)) {
          throw new BadRequestException(`The ${role} model must use ${protocols.join(' or ')} for the ${executor} executor.`);
        }
      }
      if (typeof value.instructions !== 'string' || !value.instructions.trim()) throw new BadRequestException(`Instructions for Coder role ${role} are required.`);
      const displayName = value.displayName === undefined ? undefined : value.displayName.trim();
      if (displayName !== undefined && !displayName) throw new BadRequestException(`The display name for Coder role ${role} is required.`);
      const builtIn = CODER_ROLE_TOOL_NAMES[role];
      if (!builtIn && !displayName) throw new BadRequestException(`A display name is required for custom Coder role ${role}.`);
      const entryPoints = normalizeStrings(value.entryPoints, `entry points for Coder role ${role}`);
      const allowedEntryPoints = agentTeamEntryPoints(role);
      if (entryPoints.some((entryPoint) => !allowedEntryPoints.includes(entryPoint))) throw new BadRequestException(`An entry point is not supported for Coder role ${role}.`);
      const toolNames = normalizeStrings(value.toolNames, `tool names for Coder role ${role}`);
      const allowedToolNames = builtIn ?? CUSTOM_ROLE_TOOL_NAMES;
      if (toolNames.some((toolName) => !allowedToolNames.includes(toolName as never))) throw new BadRequestException(`A tool is not supported for Coder role ${role}.`);
      normalized.push({ role, ...(displayName ? { displayName } : {}), publicModelId, instructions: value.instructions.trim(), entryPoints, toolNames, ...(executor ? { executor } : {}) });
    }

    const skillIds = new Set(values.flatMap((value) => uniqueStrings(value.skillIds, `Skill ids for Coder role ${value.role}`)));
    const mcpServerIds = new Set(values.flatMap((value) => uniqueStrings(value.mcpServerIds, `MCP server ids for Coder role ${value.role}`)));
    const skillSnapshots = await this.resolveSkills(workspaceId, skillIds);
    const mcpSnapshots = await this.resolveMcpServers(workspaceId, mcpServerIds);
    const skillsByRole = new Map(values.map((value) => [value.role, uniqueStrings(value.skillIds, `Skill ids for Coder role ${value.role}`)]));
    const mcpByRole = new Map(values.map((value) => [value.role, uniqueStrings(value.mcpServerIds, `MCP server ids for Coder role ${value.role}`)]));
    return normalized.map((role) => ({
      ...role,
      skills: skillsByRole.get(role.role)?.flatMap((id) => skillSnapshots.get(id) ? [skillSnapshots.get(id)!] : []) ?? [],
      mcpServers: mcpByRole.get(role.role)?.flatMap((id) => mcpSnapshots.get(id) ? [mcpSnapshots.get(id)!] : []) ?? [],
    }));
  }

  private async resolveSkills(workspaceId: string, skillIds: ReadonlySet<string>) {
    const rows = skillIds.size === 0 ? [] : await this.db.select().from(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, [...skillIds])));
    if (rows.length !== skillIds.size) throw new NotFoundException('A selected Skill was not found in this workspace.');
    const invalidSkill = rows.find((row) => row.validation !== 'valid');
    if (invalidSkill) throw new BadRequestException(invalidSkill.validationReason ?? `Skill ${invalidSkill.name} is invalid.`);
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    // Carry the stored instruction text alongside the package files, matching the
    // Workflow Agent node path, so a Skill whose instructions are not only in
    // SKILL.md still reaches the Coder role verbatim.
    return new Map(rows.map((row) => [row.id, {
      id: row.id,
      name: row.name,
      instructions: row.instructions,
      files: files.filter((file) => file.skillId === row.id).map((file) => ({ path: file.path, content: file.content })),
    }]));
  }

  private async resolveMcpServers(workspaceId: string, serverIds: ReadonlySet<string>) {
    const rows = serverIds.size === 0 ? [] : await this.db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, [...serverIds])));
    if (rows.length !== serverIds.size) throw new NotFoundException('A selected MCP server was not found in this workspace.');
    // A role captures the server's discovered tool set, so a never-configured
    // server connects and discovers its tools here before the capture.
    const resolved = await Promise.all(rows.map((row) => row.connection === 'unconfigured' ? this.resources.autoConnectMcpServer(row, true) : row));
    return new Map(resolved.map((row) => [row.id, { id: row.id, name: row.name, allowedToolNames: row.allowedToolNames ?? [] }]));
  }

  async deleteTeam(workspaceId: string, coderId: string, confirmTeamId: string): Promise<{ coderId: string; deletedAt: Date }> {
    if (coderId !== confirmTeamId) {
      throw new BadRequestException('The Coder id in the path and confirmTeamId in the body must match.');
    }

    // Check Coder exists and is not already deleted
    const [team] = await this.db.select().from(coders)
      .where(and(eq(coders.id, coderId), eq(coders.workspaceId, workspaceId)))
      .limit(1);
    if (!team) throw new NotFoundException('Coder not found.');
    if (team.deletedAt) throw new ConflictException('This Coder has already been deleted.');

    // Check for active runs using active statuses: queued, running, waiting_for_input, paused
    const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_for_input', 'paused'] as const;
    const [activeRunCount] = await this.db.select({ count: coderRuns.id }).from(coderRuns)
      .where(and(
        eq(coderRuns.coderId, coderId),
        eq(coderRuns.workspaceId, workspaceId),
        inArray(coderRuns.status, [...ACTIVE_RUN_STATUSES]),
      ))
      .limit(1);
    if (activeRunCount && activeRunCount.count) {
      const [activeRuns] = await this.db.select({ id: coderRuns.id }).from(coderRuns)
        .where(and(
          eq(coderRuns.coderId, coderId),
          eq(coderRuns.workspaceId, workspaceId),
          inArray(coderRuns.status, [...ACTIVE_RUN_STATUSES]),
        ))
        .limit(5);
      const activeIds = activeRuns ? await this.db.select({ id: coderRuns.id }).from(coderRuns)
        .where(and(
          eq(coderRuns.coderId, coderId),
          eq(coderRuns.workspaceId, workspaceId),
          inArray(coderRuns.status, [...ACTIVE_RUN_STATUSES]),
        ))
        .limit(5) : [];
      throw new ConflictException(
        `Cannot delete this Coder: it has ${activeRunCount.count} active run(s). ` +
        `Active run ids: ${activeIds.map((r) => r.id).join(', ')}. ` +
        `Please cancel or wait for these runs to complete before deleting.`,
      );
    }

    // Perform soft delete in a transaction
    const deletedAt = new Date();
    await this.db.update(coders)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(coders.id, coderId))
      .run();

    return { coderId, deletedAt };
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

const EXECUTOR_NAME_MAX_LENGTH = 64;

export function coderRevision(team: Pick<AgentTeam, 'updatedAt'>): number {
  return team.updatedAt.getTime();
}

// Coder names are display labels: trimmed, 1-64 characters, no control characters.
function normalizeCoderName(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('The Coder name must be text.');
  const name = value.trim();
  if (!name || [...name].length > EXECUTOR_NAME_MAX_LENGTH) {
    throw new BadRequestException(`The Coder name must be 1-${EXECUTOR_NAME_MAX_LENGTH} characters after trimming.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) throw new BadRequestException('The Coder name cannot contain control characters.');
  return name;
}

function coderNameConflict(name: string): ConflictException {
  return new ConflictException({ statusCode: 409, code: 'CODER_NAME_CONFLICT', message: `Another Coder is already named "${name}" (names are compared ignoring case).` });
}

function coderRevisionConflict(): ConflictException {
  return new ConflictException({ statusCode: 409, code: 'CODER_REVISION_CONFLICT', message: 'The Coder changed since it was read. Reload it and try again.' });
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}
