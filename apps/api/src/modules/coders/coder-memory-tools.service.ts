import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import { TeamMemoryService, type TeamMemoryActorContext } from './coder-memory.service';

const repositoryId = {
  type: ['string', 'null'],
  description: 'A repository id from the captured task context (taskGroup.repositories[].id). Omit or null for a Coder-level memory.',
};
const upsertKey = {
  type: 'string',
  description: 'Optional stable key. Writing again with the same key and scope updates the existing memory instead of adding another.',
};

const definitions: GatewayToolDefinition[] = [
  {
    name: 'coder_memory_search',
    description: 'Search this Coder’s long-term memories by keywords. Coder memories are separate from Chat memory. Results carry titles and excerpts; use coder_memory_read for full text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords describing the fact or decision you need.' },
        repositoryId: { ...repositoryId, description: 'Optional canonical repository id from the task context; omit to search Coder-level and every in-scope repository memory.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results; default 10.' },
      },
    },
  },
  {
    name: 'coder_memory_read',
    description: 'Read one Coder memory in full by id from coder_memory_search results.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['memoryId'],
      properties: { memoryId: { type: 'string' } },
    },
  },
  {
    name: 'coder_memory_write',
    description: 'Save a durable Coder fact or decision for this Coder. The write applies immediately: later dispatches project it and every role can search it. Default scope is the Coder; pass repositoryId only when the fact belongs to one repository. Writing the same normalized content in the same scope updates the existing memory. Do not save transient task details.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: { content: { type: 'string', description: 'One self-contained durable fact or decision.' }, repositoryId, upsertKey },
    },
  },
  {
    name: 'coder_memory_update',
    description: 'Correct one Coder memory by id. Use it when an existing memory is wrong or obsolete; coder_memory_write is for new facts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['memoryId'],
      properties: { memoryId: { type: 'string' }, content: { type: 'string' }, repositoryId, upsertKey },
    },
  },
];

export type RoleMemoryToolCall = { toolName: string; input: unknown };

export type RoleMemoryToolContext = Omit<TeamMemoryActorContext, 'createdBy'> & {
  // Group repository id shown in the task context -> canonical Coder repository id.
  repositoryIdAliases?: Readonly<Record<string, string>>;
};

// Role-facing Coder memory tools. The Coder, Run, attempt, role and repository scope
// come from the runtime closure on every call; model input can only choose content,
// an in-scope repository id and an idempotency/upsert key.
@Injectable()
export class AgentTeamMemoryToolsService {
  constructor(private readonly memories: TeamMemoryService) {}

  toolDefinitions(): readonly GatewayToolDefinition[] {
    return definitions;
  }

  async execute(input: { context: RoleMemoryToolContext; taskKey: string; call: RoleMemoryToolCall }): Promise<string> {
    const { repositoryIdAliases = {}, ...actor } = input.context;
    const rawArgs = asRecord(input.call.input);
    const aliasedRepositoryId = typeof rawArgs?.repositoryId === 'string' ? repositoryIdAliases[rawArgs.repositoryId.trim()] : undefined;
    const args = aliasedRepositoryId ? { ...rawArgs, repositoryId: aliasedRepositoryId } : rawArgs;
    const context: TeamMemoryActorContext = { ...actor, createdBy: 'role' };
    switch (input.call.toolName) {
      case 'coder_memory_search': {
        const results = await this.memories.search(context, {
          query: optionalString(args?.query, 'query'),
          // Omitted means every in-scope memory, not only Coder-level ones.
          repositoryId: optionalSearchRepositoryId(args?.repositoryId),
          limit: optionalInteger(args?.limit, 'limit'),
        });
        return JSON.stringify(results);
      }
      case 'coder_memory_read': {
        const memory = await this.memories.read(context, requiredString(args?.memoryId, 'memoryId'));
        return JSON.stringify(memory);
      }
      case 'coder_memory_write': {
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
      case 'coder_memory_update': {
        const result = await this.memories.update(context, {
          memoryId: requiredString(args?.memoryId, 'memoryId'),
          ...(args?.content === undefined ? {} : { content: requiredString(args.content, 'content') }),
          ...(args?.repositoryId === undefined ? {} : { repositoryId: optionalRepositoryId(args.repositoryId) }),
          ...(args?.upsertKey === undefined ? {} : { upsertKey: optionalString(args.upsertKey, 'upsertKey') }),
        });
        return JSON.stringify({ id: result.memory.id, repositoryId: result.memory.repositoryId, operation: result.operation, content: result.memory.content });
      }
      default:
        throw new BadRequestException('The Coder role requested an unavailable Coder memory tool.');
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
