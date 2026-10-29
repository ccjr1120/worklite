import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import { TeamMemoryService, type TeamMemoryActorContext } from './team-memory.service';

const repositoryId = {
  type: ['string', 'null'],
  description: 'Canonical executor repository id from the captured task context. Omit or null for an executor-level memory.',
};
const upsertKey = {
  type: 'string',
  description: 'Optional stable key. Writing again with the same key and scope updates the existing memory instead of adding another.',
};

const definitions: GatewayToolDefinition[] = [
  {
    name: 'team_memory_search',
    description: 'Search this executor’s long-term memories by keywords. Executor memories are separate from Chat memory. Results carry titles and excerpts; use team_memory_read for full text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords describing the fact or decision you need.' },
        repositoryId: { ...repositoryId, description: 'Optional canonical repository id from the task context; omit to search executor-level and every in-scope repository memory.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results; default 10.' },
      },
    },
  },
  {
    name: 'team_memory_read',
    description: 'Read one executor memory in full by id from team_memory_search results.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['memoryId'],
      properties: { memoryId: { type: 'string' } },
    },
  },
  {
    name: 'team_memory_write',
    description: 'Save a durable executor fact or decision for this executor. The write applies immediately: later dispatches project it and every role can search it. Default scope is the executor; pass repositoryId only when the fact belongs to one repository. Writing the same normalized content in the same scope updates the existing memory. Do not save transient task details.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: { content: { type: 'string', description: 'One self-contained durable fact or decision.' }, repositoryId, upsertKey },
    },
  },
  {
    name: 'team_memory_update',
    description: 'Correct one executor memory by id. Use it when an existing memory is wrong or obsolete; team_memory_write is for new facts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['memoryId'],
      properties: { memoryId: { type: 'string' }, content: { type: 'string' }, repositoryId, upsertKey },
    },
  },
];

export type RoleMemoryToolCall = { toolName: string; input: unknown };

export type RoleMemoryToolContext = Omit<TeamMemoryActorContext, 'createdBy'>;

// Role-facing executor memory tools. The executor, Run, attempt, role and repository scope
// come from the runtime closure on every call; model input can only choose content,
// an in-scope repository id and an idempotency/upsert key.
@Injectable()
export class AgentTeamMemoryToolsService {
  constructor(private readonly memories: TeamMemoryService) {}

  toolDefinitions(): readonly GatewayToolDefinition[] {
    return definitions;
  }

  async execute(input: { context: RoleMemoryToolContext; taskKey: string; call: RoleMemoryToolCall }): Promise<string> {
    const args = asRecord(input.call.input);
    const context: TeamMemoryActorContext = { ...input.context, createdBy: 'role' };
    switch (input.call.toolName) {
      case 'team_memory_search': {
        const results = await this.memories.search(context, {
          query: optionalString(args?.query, 'query'),
          // Omitted means every in-scope memory, not only executor-level ones.
          repositoryId: optionalSearchRepositoryId(args?.repositoryId),
          limit: optionalInteger(args?.limit, 'limit'),
        });
        return JSON.stringify(results);
      }
      case 'team_memory_read': {
        const memory = await this.memories.read(context, requiredString(args?.memoryId, 'memoryId'));
        return JSON.stringify(memory);
      }
      case 'team_memory_write': {
        const id = `atmemory_${createHash('sha256')
          .update(JSON.stringify([input.context.runId ?? '', input.taskKey, input.call.toolName, input.call.input]))
          .digest('hex')
          .slice(0, 32)}`;
        const result = await this.memories.write(context, {
          id,
          content: requiredString(args?.content, 'content'),
          repositoryId: optionalRepositoryId(args?.repositoryId),
          upsertKey: optionalString(args?.upsertKey, 'upsertKey'),
        });
        return JSON.stringify({
          id: result.memory.id,
          repositoryId: result.memory.repositoryId,
          operation: result.operation,
          content: result.memory.content,
        });
      }
      case 'team_memory_update': {
        const result = await this.memories.update(context, {
          memoryId: requiredString(args?.memoryId, 'memoryId'),
          ...(args?.content === undefined ? {} : { content: requiredString(args.content, 'content') }),
          ...(args?.repositoryId === undefined ? {} : { repositoryId: optionalRepositoryId(args.repositoryId) }),
          ...(args?.upsertKey === undefined ? {} : { upsertKey: optionalString(args.upsertKey, 'upsertKey') }),
        });
        return JSON.stringify({ id: result.memory.id, repositoryId: result.memory.repositoryId, operation: result.operation, content: result.memory.content });
      }
      default:
        throw new BadRequestException('The executor role requested an unavailable executor memory tool.');
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, field);
}

function optionalRepositoryId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, 'repositoryId');
}

function optionalSearchRepositoryId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredString(value, 'repositoryId');
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new BadRequestException(`${field} must be a positive integer.`);
  return value as number;
}
