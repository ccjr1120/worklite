import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { VolcengineSearchService } from '../web-search/volcengine-search.service';
import type { WebFetchService } from '../web-search/web-fetch.service';

// Stable server id so Claude Code exposes mcp__volcengine_search__<tool>.
export const VOLCENGINE_SEARCH_MCP_SERVER_ID = 'volcengine_search';
export const VOLCENGINE_SEARCH_MCP_TOOL_NAMES = ['web_search', 'web_fetch'] as const;

export function volcengineSearchMcpEndpoint(): string {
  const configured = process.env.WORKLITE_API_URL?.trim();
  const base = configured || `http://127.0.0.1:${Number(process.env.API_PORT ?? 23391)}/api`;
  return `${base.replace(/\/+$/, '')}/mcp/volcengine-search`;
}

/**
 * Stateless MCP server for one call. The search key is resolved by the caller:
 * an inbound Authorization bearer key wins, otherwise the API environment key.
 * It is never included in a tool description, result or error.
 */
export function createVolcengineSearchMcpServer(options: {
  searches: VolcengineSearchService;
  pages: WebFetchService;
  apiKey: string | null;
}): McpServer {
  const server = new McpServer({ name: 'worklite-volcengine-search', version: '1.0.0' });

  server.registerTool('web_search', {
    title: 'Web search',
    description: 'Search the live web through the configured Volcengine search credential. Returns bounded results with title, URL, site, publish time and summary. Set needContent only when the result body itself is required; prefer web_fetch for one page.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string().min(1).max(100).describe('Search query, 1 to 100 characters.'),
      count: z.number().int().min(1).max(50).optional().describe('Result count; defaults to 10.'),
      searchType: z.enum(['web', 'image']).optional().describe('Search type; defaults to web.'),
      timeRange: z.string().optional().describe('OneDay, OneWeek, OneMonth, OneYear, or two YYYY-MM-DD dates joined by "..".'),
      sites: z.array(z.string()).min(1).max(20).optional().describe('Restrict results to these sites, at most 20.'),
      blockHosts: z.array(z.string()).min(1).max(5).optional().describe('Hosts to exclude, at most 5.'),
      needContent: z.boolean().optional().describe('Include a bounded body excerpt for every result; defaults to false.'),
      needUrl: z.boolean().optional().describe('Include result URLs; defaults to true.'),
      authInfoLevel: z.union([z.literal(0), z.literal(1)]).optional().describe('Optional ICP authentication detail level.'),
      icpHostOnly: z.boolean().optional().describe('Restrict results to ICP-registered hosts.'),
      queryRewrite: z.boolean().optional().describe('Allow the search service to rewrite the query.'),
      contentFormats: z.array(z.enum(['text', 'markdown'])).min(1).max(2).optional().describe('Requested format for result body content.'),
      industry: z.enum(['finance', 'game', 'health', 'gov']).optional().describe('Optional industry filter.'),
      enableWaiting: z.boolean().optional().describe('Wait for the search service to finish when supported.'),
      maxWaitTime: z.number().int().min(1).max(30).optional().describe('Maximum search wait in seconds; defaults to the service behavior.'),
    },
  }, async (args) => {
    try {
      const result = await options.searches.search(args, options.apiKey);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('web_fetch', {
    title: 'Fetch web page',
    description: 'Fetch one public http(s) page and return its readable text with the page title. Private, loopback and link-local targets are rejected; redirects, body size and time are bounded. Use it after web_search when one page matters.',
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
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'The web search tool failed.' }],
    isError: true,
  };
}
