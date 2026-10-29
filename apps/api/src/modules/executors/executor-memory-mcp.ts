import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentTeamMemoryToolsService } from './executor-memory-tools.service';
import type { TeamMemoryActorContext } from './executor-memory.service';

// The fixed MCP server id makes Claude Code expose these as
// mcp__worklite_executor_memory__<tool> and keeps Codex's mcp_servers.<key> stable.
export const TEAM_MEMORY_MCP_SERVER_ID = 'executor_memory';
export const TEAM_MEMORY_MCP_TOOL_NAMES = ['executor_memory_search', 'executor_memory_read', 'executor_memory_write'] as const;

export function teamMemoryMcpEndpoint(): string {
  const configured = process.env.WORKLITE_API_URL?.trim();
  const base = configured || `http://127.0.0.1:${Number(process.env.API_PORT ?? 23391)}/api`;
  return `${base.replace(/\/+$/, '')}/internal/executor-memory-mcp`;
}

/**
 * Synthetic MCP server runtime handed to a project executor. The bearer token binds
 * the endpoint to this Run's executor, attempt, role and repository scope.
 */
export function teamMemoryMcpRuntime(authToken: string): {
  id: string;
  name: string;
  endpoint: string;
  authToken: string;
  allowedTools: string[];
} {
  return {
    id: TEAM_MEMORY_MCP_SERVER_ID,
    name: 'Executor Memory',
    endpoint: teamMemoryMcpEndpoint(),
    authToken,
    allowedTools: [...TEAM_MEMORY_MCP_TOOL_NAMES],
  };
}

/**
 * Stateless MCP server for one authenticated executor binding. Every request runs
 * with the context captured in the token; request arguments can never select a
 * different executor, Run or repository scope.
 */
export function createTeamMemoryMcpServer(
  tools: AgentTeamMemoryToolsService,
  context: TeamMemoryActorContext,
): Server {
  const server = new Server(
    { name: 'worklite-executor-memory', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const allowed = new Set<string>(TEAM_MEMORY_MCP_TOOL_NAMES);
  const definitions = tools.toolDefinitions()
    .filter((definition) => allowed.has(definition.name))
    .map((definition) => ({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!allowed.has(request.params.name)) {
      return { content: [{ type: 'text' as const, text: `Unknown executor memory tool: ${request.params.name}` }], isError: true };
    }
    try {
      const value = await tools.execute({
        context,
        taskKey: 'mcp',
        call: { toolName: request.params.name, input: request.params.arguments ?? {} },
      });
      return { content: [{ type: 'text' as const, text: value }] };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'The executor memory tool failed.' }],
        isError: true,
      };
    }
  });
  return server;
}
