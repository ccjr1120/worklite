import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { AgentTeamRoleConfiguration, AgentTeamView } from '@worklite/contracts';
import {
  agentTeamGroupEvents,
  agentTeamMemories,
  agentTeamRepositories,
  type Database,
} from '@worklite/db';
import type { GatewayToolDefinition, WorkflowAgentToolCall } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { AgentTeamConfigurationService } from './agent-team-configuration.service';
import { BUILT_IN_AGENT_TEAM_ID } from './agent-team-configuration';

const emptyObject = { type: 'object', additionalProperties: false, properties: {} };
const string = { type: 'string' };
const strings = { type: 'array', items: string };

const definitions: GatewayToolDefinition[] = [
  { name: 'team_get_configuration', description: 'Read current Coding Executors team settings, every active role configuration, and canonical repository ids and names for memory scope. Project directory paths are not returned.', inputSchema: emptyObject },
  { name: 'team_update_settings', description: 'Update the Team Manager workingPractice and/or maxConcurrentRuns for future Runs.', inputSchema: { type: 'object', additionalProperties: false, properties: { workingPractice: { type: 'string', description: 'Team Manager working-practice text captured by future group Runs and injected into the Manager turns.' }, maxConcurrentRuns: { type: 'integer', minimum: 1, description: 'Maximum concurrent Runs; additional Runs queue FIFO.' } } } },
  { name: 'team_create_role', description: 'Create a configured Team work role. The server assigns its stable role id; provide a human-readable displayName. An empty publicModelId uses the Team default. New roles affect future Runs.', inputSchema: { type: 'object', additionalProperties: false, required: ['displayName', 'publicModelId', 'instructions'], properties: { displayName: string, publicModelId: { type: 'string', description: 'Gateway public model id, or an empty string to use the Team default.' }, instructions: string, entryPoints: { ...strings, description: 'Supported BMAD/TEA process entry points for this role.' }, skillIds: { ...strings, description: 'Current workspace Skill ids to capture for this role.' }, mcpServerIds: { ...strings, description: 'Current workspace MCP server ids to capture for this role.' }, toolNames: { ...strings, description: 'Allowed built-in tool names for this role.' }, executor: { type: 'string', enum: ['claude', 'codex'], description: 'Optional project executor; omit to use the WorkLite Agent.' } } } },
  { name: 'team_update_role', description: 'Update one active work role. Use its role id from team_get_configuration. Team Manager is protected and cannot be changed through this tool. Set executor to null to remove a project executor from a non-Developer role; Developer always uses Claude Code or Codex.', inputSchema: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', description: 'Active work-role id from team_get_configuration.' }, displayName: string, publicModelId: string, instructions: string, entryPoints: strings, skillIds: strings, mcpServerIds: strings, toolNames: strings, executor: { type: ['string', 'null'], enum: ['claude', 'codex', null], description: 'Set null to remove the project executor from a non-Developer role. Developer always remains project-executor-backed and defaults to Claude Code.' } } } },
  { name: 'team_delete_role', description: 'Delete one work role. Team Manager is protected.', inputSchema: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', description: 'Active work-role id from team_get_configuration.' } } } },
  { name: 'team_list_memories', description: 'List Team long-term memories, optionally filtered by canonical repository id from team_get_configuration. Team memories belong to the Team Manager and are injected into its own turns only.', inputSchema: { type: 'object', additionalProperties: false, properties: { repositoryId: { type: 'string', description: 'Canonical repository id from team_get_configuration.repositories.' } } } },
  { name: 'team_create_memory', description: 'Create a Team memory, optionally scoped to a canonical repository. This is Team Manager memory, separate from Chat memory.', inputSchema: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: string, repositoryId: { type: 'string', description: 'Optional canonical repository id from team_get_configuration.repositories; omit for all repositories.' } } } },
  { name: 'team_update_memory', description: 'Update a Team memory content or its repository scope. Set repositoryId to null to clear the scope.', inputSchema: { type: 'object', additionalProperties: false, required: ['memoryId'], properties: { memoryId: { type: 'string', description: 'Team memory id from team_list_memories.' }, content: string, repositoryId: { type: ['string', 'null'], description: 'Canonical repository id from team_get_configuration.repositories; null clears the scope.' } } } },
  { name: 'team_delete_memory', description: 'Delete one Team memory by id from team_list_memories.', inputSchema: { type: 'object', additionalProperties: false, required: ['memoryId'], properties: { memoryId: string } } },
];

@Injectable()
export class AgentTeamManagerToolsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly configuration: AgentTeamConfigurationService,
  ) {}

  toolDefinitions(): readonly GatewayToolDefinition[] {
    return definitions;
  }

  async execute(input: {
    workspaceId: string;
    groupId: string;
    runId: string;
    taskKey: string;
    sourceMessageId: string;
    call: WorkflowAgentToolCall;
  }): Promise<string> {
    const args = asRecord(input.call.input);
    const team = await this.configuration.getTeam(input.workspaceId, BUILT_IN_AGENT_TEAM_ID);
    switch (input.call.toolName) {
      case 'team_get_configuration': {
        const repositories = await this.db.select({ id: agentTeamRepositories.id, name: agentTeamRepositories.name })
          .from(agentTeamRepositories)
          .where(and(eq(agentTeamRepositories.workspaceId, input.workspaceId), eq(agentTeamRepositories.teamId, team.id)))
          .orderBy(asc(agentTeamRepositories.name));
        return JSON.stringify({ ...toTeamView(team), repositories });
      }
      case 'team_update_settings': {
        const update: { workingPractice?: string; maxConcurrentRuns?: number } = {};
        if (args?.workingPractice !== undefined) update.workingPractice = requiredString(args.workingPractice, 'workingPractice', true);
        if (args?.maxConcurrentRuns !== undefined) update.maxConcurrentRuns = positiveInteger(args.maxConcurrentRuns, 'maxConcurrentRuns');
        if (!Object.keys(update).length) throw new BadRequestException('Provide workingPractice or maxConcurrentRuns.');
        return JSON.stringify(toTeamView(await this.configuration.update(input.workspaceId, team.id, update)));
      }
      case 'team_create_role': {
        const roleId = `role_${createHash('sha256').update(JSON.stringify([input.runId, input.taskKey, input.call.input])).digest('hex').slice(0, 32)}`;
        const created = await this.configuration.createRole(input.workspaceId, team.id, {
          displayName: requiredString(args?.displayName, 'displayName'),
          publicModelId: requiredString(args?.publicModelId, 'publicModelId', true),
          instructions: requiredString(args?.instructions, 'instructions'),
          entryPoints: optionalStrings(args?.entryPoints, 'entryPoints'),
          skillIds: optionalStrings(args?.skillIds, 'skillIds'),
          mcpServerIds: optionalStrings(args?.mcpServerIds, 'mcpServerIds'),
          toolNames: optionalStrings(args?.toolNames, 'toolNames'),
          ...(args?.executor === undefined ? {} : { executor: parseExecutor(args.executor) }),
        }, roleId);
        return JSON.stringify(toTeamView(created));
      }
      case 'team_update_role': {
        const role = requiredString(args?.role, 'role');
        const changes: Partial<Omit<AgentTeamRoleConfiguration, 'role'>> = {};
        if (args?.displayName !== undefined) changes.displayName = requiredString(args.displayName, 'displayName');
        if (args?.publicModelId !== undefined) changes.publicModelId = requiredString(args.publicModelId, 'publicModelId', true);
        if (args?.instructions !== undefined) changes.instructions = requiredString(args.instructions, 'instructions');
        if (args?.entryPoints !== undefined) changes.entryPoints = optionalStrings(args.entryPoints, 'entryPoints');
        if (args?.skillIds !== undefined) changes.skillIds = optionalStrings(args.skillIds, 'skillIds');
        if (args?.mcpServerIds !== undefined) changes.mcpServerIds = optionalStrings(args.mcpServerIds, 'mcpServerIds');
        if (args?.toolNames !== undefined) changes.toolNames = optionalStrings(args.toolNames, 'toolNames');
        if (args?.executor !== undefined) changes.executor = args.executor === null ? null : parseExecutor(args.executor);
        return JSON.stringify(toTeamView(await this.configuration.updateRole(input.workspaceId, team.id, role, changes)));
      }
      case 'team_delete_role':
        return JSON.stringify(toTeamView(await this.configuration.deleteRole(input.workspaceId, team.id, requiredString(args?.role, 'role'))));
      case 'team_list_memories': {
        const rows = await this.db.select({ memory: agentTeamMemories, repositoryName: agentTeamRepositories.name })
          .from(agentTeamMemories).leftJoin(agentTeamRepositories, eq(agentTeamRepositories.id, agentTeamMemories.repositoryId))
          .where(and(eq(agentTeamMemories.workspaceId, input.workspaceId), eq(agentTeamMemories.teamId, team.id)))
          .orderBy(desc(agentTeamMemories.updatedAt));
        const repositoryId = args?.repositoryId === undefined ? undefined : requiredString(args.repositoryId, 'repositoryId');
        return JSON.stringify(rows.filter(({ memory }) => repositoryId === undefined || memory.repositoryId === repositoryId).map(({ memory, repositoryName }) => ({
          id: memory.id, repositoryId: memory.repositoryId, repositoryName: repositoryName ?? null,
          content: memory.content, sourceMessageId: memory.sourceMessageId,
          createdAt: memory.createdAt?.toISOString() ?? null, updatedAt: memory.updatedAt?.toISOString() ?? null,
        })));
      }
      case 'team_create_memory': {
        const content = requiredString(args?.content, 'content');
        const repositoryId = optionalString(args?.repositoryId, 'repositoryId');
        await this.assertMemoryScope(input.workspaceId, team.id, repositoryId ?? null);
        const id = `atmemory_${createHash('sha256').update(JSON.stringify([input.runId, input.taskKey, input.call.toolName, input.call.input])).digest('hex').slice(0, 32)}`;
        await this.db.insert(agentTeamMemories).values({
          id, workspaceId: input.workspaceId, teamId: team.id, repositoryId: repositoryId ?? null, role: null,
          content, sourceMessageId: input.sourceMessageId, createdAt: new Date(), updatedAt: new Date(),
        }).onConflictDoNothing();
        const [memory] = await this.db.select().from(agentTeamMemories).where(eq(agentTeamMemories.id, id)).limit(1);
        await this.appendMemoryEvent(input.groupId, { memoryId: id, operation: 'created' });
        return JSON.stringify(memory ? { id: memory.id, content: memory.content, repositoryId: memory.repositoryId } : { id });
      }
      case 'team_update_memory': {
        const memoryId = requiredString(args?.memoryId, 'memoryId');
        const [existing] = await this.db.select().from(agentTeamMemories).where(and(
          eq(agentTeamMemories.id, memoryId), eq(agentTeamMemories.teamId, team.id), eq(agentTeamMemories.workspaceId, input.workspaceId),
        )).limit(1);
        if (!existing) throw new NotFoundException('Coding Executors team memory not found.');
        const content = args?.content === undefined ? existing.content : requiredString(args.content, 'content');
        const repositoryId = args?.repositoryId === undefined ? existing.repositoryId : optionalString(args.repositoryId, 'repositoryId') ?? null;
        await this.assertMemoryScope(input.workspaceId, team.id, repositoryId);
        const [updated] = await this.db.update(agentTeamMemories).set({ content, repositoryId, updatedAt: new Date() })
          .where(eq(agentTeamMemories.id, memoryId)).returning();
        await this.appendMemoryEvent(input.groupId, { memoryId, operation: 'updated' });
        return JSON.stringify({ id: updated!.id, content: updated!.content, repositoryId: updated!.repositoryId });
      }
      case 'team_delete_memory': {
        const memoryId = requiredString(args?.memoryId, 'memoryId');
        const deleted = await this.db.delete(agentTeamMemories).where(and(
          eq(agentTeamMemories.id, memoryId), eq(agentTeamMemories.teamId, team.id), eq(agentTeamMemories.workspaceId, input.workspaceId),
        )).returning({ id: agentTeamMemories.id });
        if (!deleted.length) throw new NotFoundException('Coding Executors team memory not found.');
        await this.appendMemoryEvent(input.groupId, { memoryId, operation: 'deleted' });
        return JSON.stringify({ deleted: memoryId });
      }
      default:
        throw new BadRequestException('The isolated Team Manager requested an unavailable tool.');
    }
  }

  private async assertMemoryScope(workspaceId: string, teamId: string, repositoryId: string | null): Promise<void> {
    if (repositoryId) {
      const [repository] = await this.db.select({ id: agentTeamRepositories.id }).from(agentTeamRepositories).where(and(
        eq(agentTeamRepositories.id, repositoryId), eq(agentTeamRepositories.teamId, teamId), eq(agentTeamRepositories.workspaceId, workspaceId),
      )).limit(1);
      if (!repository) throw new BadRequestException('The memory repository is not available for this Coding Executors team.');
    }
  }

  private async appendMemoryEvent(groupId: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.transaction((transaction) => {
      const [latest] = transaction.select({ sequence: agentTeamGroupEvents.sequence }).from(agentTeamGroupEvents)
        .where(eq(agentTeamGroupEvents.groupId, groupId)).orderBy(desc(agentTeamGroupEvents.sequence)).limit(1).all();
      transaction.insert(agentTeamGroupEvents).values({ groupId, sequence: (latest?.sequence ?? 0) + 1, type: 'memory.updated', payload, createdAt: new Date() }).run();
    });
  }
}

function toTeamView(team: Awaited<ReturnType<AgentTeamConfigurationService['getTeam']>>): AgentTeamView {
  return {
    id: team.id, name: team.name, description: team.description, processId: team.processId, processVersion: team.processVersion,
    maxConcurrentRuns: team.maxConcurrentRuns, workingPractice: team.workingPractice, projectGitPolicy: team.projectGitPolicy,
    roles: team.roles.map((role) => ({
      role: role.role, ...(role.displayName ? { displayName: role.displayName } : {}), publicModelId: role.publicModelId,
      instructions: role.instructions, entryPoints: role.entryPoints, skillIds: role.skills.map((skill) => skill.id),
      mcpServerIds: role.mcpServers.map((server) => server.id), toolNames: role.toolNames,
      ...(role.executor ? { executor: role.executor } : role.role === 'developer' ? { executor: 'claude' as const } : {}),
    })),
    createdAt: team.createdAt?.toISOString() ?? new Date(0).toISOString(), updatedAt: team.updatedAt?.toISOString() ?? new Date(0).toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new BadRequestException(`${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === null || value === '') return undefined;
  return requiredString(value, field);
}

function optionalStrings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new BadRequestException(`${field} must be an array of non-empty strings.`);
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function parseExecutor(value: unknown): 'claude' | 'codex' {
  if (value !== 'claude' && value !== 'codex') throw new BadRequestException('executor must be claude or codex.');
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new BadRequestException(`${field} must be an integer of at least 1.`);
  return value as number;
}
