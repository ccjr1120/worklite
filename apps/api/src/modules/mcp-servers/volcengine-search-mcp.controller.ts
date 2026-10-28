import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebFetchService } from '../web-search/web-fetch.service';
import { createVolcengineSearchMcpServer } from './volcengine-search-mcp';

/**
 * Local-only stateless MCP endpoint for Workflow Agent nodes and any workspace
 * MCP server resource. The API itself still listens only on the configured API host.
 */
@Controller('mcp/volcengine-search')
export class VolcengineSearchMcpController {
  constructor(private readonly pages: WebFetchService) {}

  @All()
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const server = createVolcengineSearchMcpServer({ pages: this.pages });
    // WorkLite creates one MCP client per call and closes it, so this endpoint is
    // deliberately stateless and safe to reuse across concurrent requests.
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
