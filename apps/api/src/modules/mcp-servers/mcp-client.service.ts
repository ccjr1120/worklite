import { Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpConnectionConfig = {
  endpoint: string;
  authToken?: string;
};

export type McpDiscoveredTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

@Injectable()
export class McpClientService {
  async discover(config: McpConnectionConfig, signal?: AbortSignal): Promise<McpDiscoveredTool[]> {
    return this.withClient(config, signal, async (client) => {
      const result = await client.listTools(undefined, { signal });
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }));
    });
  }

  async call(config: McpConnectionConfig, name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.withClient(config, signal, (client) => client.callTool({
      name,
      arguments: isObject(input) ? input : {},
    }, undefined, { signal }));
  }

  private async withClient<T>(
    config: McpConnectionConfig,
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: 'worklite', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
      requestInit: config.authToken
        ? { headers: { Authorization: `Bearer ${config.authToken}` } }
        : undefined,
    });
    try {
      await client.connect(transport, { signal });
      return await operation(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
