import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSearchCredentialService } from '../web-search/web-search-credential.service';
import { VolcengineSearchService } from '../web-search/volcengine-search.service';
import { WebFetchService } from '../web-search/web-fetch.service';
import { createVolcengineSearchMcpServer } from './volcengine-search-mcp';

/**
 * Local-only stateless MCP endpoint for Workflow Agent nodes and any workspace
 * MCP server resource. An inbound bearer key overrides the stored workspace key;
 * the API itself still listens only on the configured API host.
 */
@Controller('mcp/volcengine-search')
export class VolcengineSearchMcpController {
  constructor(
    private readonly credentials: WebSearchCredentialService,
    private readonly searches: VolcengineSearchService,
    private readonly pages: WebFetchService,
  ) {}

  @All()
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const apiKey = bearerToken(request.headers.authorization) ?? await this.credentials.read();
    const server = createVolcengineSearchMcpServer({ searches: this.searches, pages: this.pages, apiKey });
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

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? '');
  return match?.[1]?.trim() || undefined;
}
