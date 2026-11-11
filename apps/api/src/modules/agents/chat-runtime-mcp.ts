import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ProjectExecutorMcpServer } from './project-executor.types';

export type ChatRuntimeTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ChatRuntimeQuestion = { options?: string[]; action?: 'new_conversation' };
export type AskChatRuntime = (question: string, details?: ChatRuntimeQuestion) => Promise<string>;
export type ChatRuntimeTools = {
  definitions: ChatRuntimeTool[];
  execute: (name: string, input: Record<string, unknown>, ask: AskChatRuntime) => Promise<string>;
};

/** One turn, one bearer token, loopback only. Neither arguments nor the client select the conversation. */
export async function openChatRuntimeMcp(tools: ChatRuntimeTools, ask: AskChatRuntime) {
  const token = randomBytes(32).toString('hex');
  const connections = new Set<Server>();
  let queue = Promise.resolve();
  let closing = false;
  const http = createServer(async (request, response) => {
    if (request.url !== '/mcp' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const server = new Server({ name: 'worklite-chat', version: '1.0.0' }, { capabilities: { tools: {} } });
    connections.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.definitions.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema, type: 'object' as const } })) }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      // Platform operations share mutable configuration. Preserve request order even when an engine batches calls.
      const result = queue.then(async () => {
        if (closing) throw new Error('This runtime turn has ended.');
        if (!tools.definitions.some((tool) => tool.name === params.name)) throw new Error('Unknown Chat tool.');
        return tools.execute(params.name, params.arguments ?? {}, ask);
      });
      queue = result.then(() => undefined, () => undefined);
      try { return { content: [{ type: 'text', text: await result }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Chat tool failed.' }] }; }
    });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('MCP request is too large.');
        chunks.push(Buffer.from(chunk));
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.end();
    } finally {
      connections.delete(server);
      await server.close().catch(() => undefined);
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Chat MCP could not bind a loopback port.');
  return {
    runtime: { id: 'chat', name: 'WorkLite Chat', endpoint: `http://127.0.0.1:${address.port}/mcp`, authToken: token, allowedTools: tools.definitions.map((tool) => tool.name) } satisfies ProjectExecutorMcpServer,
    close: async () => {
      closing = true;
      // Dispose only after the active operation stops; queued old-turn requests must never
      // run against the next turn's mutable state. Callers abort tools before closing.
      await queue;
      await Promise.all([...connections].map((server) => server.close().catch(() => undefined)));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
