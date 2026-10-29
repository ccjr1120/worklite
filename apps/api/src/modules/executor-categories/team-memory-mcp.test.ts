import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  executorCategoryMemories,
  executorCategoryRepositories,
  executorCategories,
  createDb,
  initializeDatabase,
  workspaces,
  type Database,
} from '@worklite/db';
import { AgentTeamMemoryToolsService } from './executor-category-memory-tools.service';
import { createTeamMemoryMcpServer, TEAM_MEMORY_MCP_TOOL_NAMES, teamMemoryMcpRuntime } from './team-memory-mcp';
import { TeamMemoryMcpController } from './team-memory-mcp.controller';
import { TeamMemoryMcpTokenService } from './team-memory-mcp-token.service';
import { TeamMemoryService, type TeamMemoryActorContext } from './team-memory.service';

// The executor MCP endpoint trusts only the per-task bearer token. An invalid,
// missing or revoked token is a 401 and never reaches executor category memory.

let db: Database;
let tokens: TeamMemoryMcpTokenService;
let tools: AgentTeamMemoryToolsService;

const context: TeamMemoryActorContext = {
  workspaceId: 'workspace_a',
  executorCategoryId: 'team_a',
  runId: 'atrun_a',
  taskAttemptId: 'attempt_a',
  role: 'developer',
  allowedRepositoryIds: ['repo_a1'],
  createdBy: 'role',
};

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const now = new Date();
  await db.insert(workspaces).values({ id: 'workspace_a', slug: 'a', name: 'A', createdAt: now, updatedAt: now });
  await db.insert(executorCategories).values({
    id: 'team_a', workspaceId: 'workspace_a', name: 'Team A', description: '', processId: 'bmad-tea', processVersion: '1', createdAt: now, updatedAt: now,
  });
  await db.insert(executorCategoryRepositories).values({
    id: 'repo_a1', workspaceId: 'workspace_a', executorCategoryId: 'team_a', name: 'api', directory: '/projects/api', createdAt: now, updatedAt: now,
  });
  tokens = new TeamMemoryMcpTokenService();
  tools = new AgentTeamMemoryToolsService(new TeamMemoryService(db));
});

afterEach(() => {
  db.$client.close();
});

function responseSpy(): Response {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
}

async function mcpClient(authContext: TeamMemoryActorContext): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTeamMemoryMcpServer(tools, authContext);
  await server.connect(serverTransport);
  const client = new Client({ name: 'team-memory-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('TeamMemoryMcpController authentication', () => {
  it('rejects a missing or unknown token with 401', async () => {
    const controller = new TeamMemoryMcpController(tokens, tools);

    const missing = responseSpy();
    await controller.handle({ headers: {} } as Request, missing);
    expect(missing.status).toHaveBeenCalledWith(401);

    const unknown = responseSpy();
    await controller.handle({ headers: { authorization: 'Bearer wtm_unknown' } } as Request, unknown);
    expect(unknown.status).toHaveBeenCalledWith(401);
  });

  it('rejects a revoked token with 401', async () => {
    const token = tokens.register(context);
    expect(tokens.resolve(token)).toMatchObject({ executorCategoryId: 'team_a', runId: 'atrun_a' });
    tokens.revoke(token);

    const controller = new TeamMemoryMcpController(tokens, tools);
    const response = responseSpy();
    await controller.handle({ headers: { authorization: `Bearer ${token}` } } as Request, response);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ message: 'A valid executor category memory MCP token is required.' });
  });

  it('expires stale bindings instead of resolving them', () => {
    const token = tokens.register(context);
    // The service uses wall-clock expiry; a binding after its TTL must not resolve.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 60 * 60 * 1000);
    expect(tokens.resolve(token)).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('executor category memory MCP server', () => {
  it('lists exactly the executor-facing tools', async () => {
    const { client, close } = await mcpClient(context);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...TEAM_MEMORY_MCP_TOOL_NAMES]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
    } finally {
      await close();
    }
  });

  it('writes with the token-bound Team and rejects an out-of-scope repository', async () => {
    const { client, close } = await mcpClient(context);
    try {
      const written = await client.callTool({
        name: 'team_memory_write',
        arguments: { content: 'Executor fact.', repositoryId: 'repo_a1', executorCategoryId: 'team_b' },
      });
      expect(written.isError).toBeFalsy();
      const [row] = await db.select().from(executorCategoryMemories);
      expect(row).toMatchObject({ executorCategoryId: 'team_a', workspaceId: 'workspace_a', createdBy: 'role', repositoryId: 'repo_a1' });

      const rejected = await client.callTool({
        name: 'team_memory_write',
        arguments: { content: 'Escaped fact.', repositoryId: 'repo_outside' },
      });
      expect(rejected.isError).toBe(true);
      expect(await db.select().from(executorCategoryMemories)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('reports unknown tool names as errors rather than executing them', async () => {
    const { client, close } = await mcpClient(context);
    try {
      const result = await client.callTool({ name: 'team_memory_delete', arguments: { memoryId: 'x' } });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('teamMemoryMcpRuntime', () => {
  it('builds the stable worklite_team_memory server identity', () => {
    const runtime = teamMemoryMcpRuntime('wtm_token');
    expect(runtime).toMatchObject({ id: 'team_memory', name: 'Team Memory', authToken: 'wtm_token' });
    expect(runtime.endpoint).toMatch(/\/api\/internal\/team-memory-mcp$/);
    expect(runtime.allowedTools).toEqual([...TEAM_MEMORY_MCP_TOOL_NAMES]);
  });
});
