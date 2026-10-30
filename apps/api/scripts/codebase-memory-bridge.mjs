// Local read-only Streamable HTTP adapter for the installed stdio MCP server.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const executable = process.env.CODEBASE_MEMORY_EXECUTABLE;
if (!executable) throw new Error('CODEBASE_MEMORY_EXECUTABLE is required');
const port = Number(process.env.CODEBASE_MEMORY_BRIDGE_PORT || 23405);
const allowed = new Set(['list_projects', 'index_status', 'check_index_coverage', 'search_graph', 'trace_path', 'get_code_snippet', 'get_file_outline', 'get_graph_schema', 'get_architecture', 'query_graph', 'search_code', 'detect_changes', 'compare_graphs']);

http.createServer(async (req, res) => {
  if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404).end(); return; }
  if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_048_576) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const server = new Server({ name: 'worklite-codebase-memory-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'worklite-codebase-memory-bridge', version: '1.0.0' });
    let connected = false;
    const connect = async () => {
      if (!connected) {
        await client.connect(new StdioClientTransport({ command: executable, args: [], stderr: 'pipe' }));
        connected = true;
      }
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await connect();
      const result = await client.listTools();
      return { tools: result.tools.filter((tool) => allowed.has(tool.name)) };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (!allowed.has(params.name)) throw new Error('Tool is not available through this bridge');
      await connect();
      return client.callTool({ name: params.name, arguments: params.arguments });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } finally {
      await server.close().catch(() => {});
      await client.close().catch(() => {});
    }
  } catch (error) {
    console.error('codebase-memory bridge request failed:', error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'MCP bridge request failed' }));
    else if (!res.writableEnded) res.end();
  }
}).listen(port, '127.0.0.1', () => console.error(`codebase-memory bridge listening on 127.0.0.1:${port}`));
