import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WebFetchService } from '../web-search/web-fetch.service';

// Stable server id so Claude Code exposes mcp__volcengine_search__<tool>.
export const VOLCENGINE_SEARCH_MCP_SERVER_ID = 'volcengine_search';
export const VOLCENGINE_SEARCH_MCP_TOOL_NAMES = ['web_fetch'] as const;

export function volcengineSearchMcpEndpoint(): string {
  const configured = process.env.WORKLITE_API_URL?.trim();
  const base = configured || `http://127.0.0.1:${Number(process.env.API_PORT ?? 23391)}/api`;
  return `${base.replace(/\/+$/, '')}/mcp/volcengine-search`;
}

/**
 * Stateless MCP server for one call.
 */
export function createVolcengineSearchMcpServer(options: {
  pages: WebFetchService;
}): McpServer {
  const server = new McpServer({ name: 'worklite-volcengine-search', version: '1.0.0' });

  server.registerTool('web_fetch', {
    title: 'Fetch web page',
    description: 'Fetch one public http(s) page and return its readable text with the page title. Private, loopback and link-local targets are rejected; redirects, body size and time are bounded. Use it when the URL is already known.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      url: z.string().min(1).max(2000).describe('Absolute http or https URL of a public page.'),
      maxChars: z.number().int().min(500).max(20000).optional().describe('Maximum extracted characters; defaults to 8000.'),
    },
  }, async (args) => {
    try {
      const result = await options.pages.fetchPage(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

function toolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'The web fetch tool failed.' }],
    isError: true,
  };
}
