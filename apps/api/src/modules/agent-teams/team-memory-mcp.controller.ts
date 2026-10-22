import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AgentTeamMemoryToolsService } from './agent-team-memory-tools.service';
import { TeamMemoryMcpTokenService } from './team-memory-mcp-token.service';
import { createTeamMemoryMcpServer } from './team-memory-mcp';

// Internal MCP endpoint for project executors. It is not a user-facing route: the
// only credential is the short-lived token the runtime registers for one task.
@Controller('internal/team-memory-mcp')
export class TeamMemoryMcpController {
  constructor(
    private readonly tokens: TeamMemoryMcpTokenService,
    private readonly tools: AgentTeamMemoryToolsService,
  ) {}

  @All()
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const token = bearerToken(request.headers.authorization);
    const context = this.tokens.resolve(token);
    if (!context) {
      response.status(401).json({ message: 'A valid Team memory MCP token is required.' });
      return;
    }
    const server = createTeamMemoryMcpServer(this.tools, context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await server.close().catch(() => undefined);
    }
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  return match?.[1]?.trim() || undefined;
}
