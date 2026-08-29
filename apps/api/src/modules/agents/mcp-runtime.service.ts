import { Injectable } from '@nestjs/common';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { AgentMcpRuntime } from '../teams/team-resources.service';
import { McpClientService } from '../mcp-servers/mcp-client.service';

export type McpRuntimeTool = GatewayToolDefinition & {
  serverId: string;
  serverName: string;
  remoteName: string;
};

@Injectable()
export class McpRuntimeService {
  constructor(private readonly client: McpClientService) {}

  async discover(runtimes: readonly AgentMcpRuntime[], signal?: AbortSignal): Promise<McpRuntimeTool[]> {
    const tools: McpRuntimeTool[] = [];
    for (const runtime of runtimes) {
      try {
        const toolsForServer = await this.client.discover(runtime, signal);
        for (const tool of toolsForServer.filter((candidate) => runtime.allowedTools.includes(candidate.name))) {
          const modelName = `mcp_${runtime.id}_${tool.name}`;
          tools.push({
            name: modelName,
            remoteName: tool.name,
            serverId: runtime.id,
            serverName: runtime.name,
            description: tool.description ?? `Call ${tool.name} on ${runtime.name}.`,
            inputSchema: tool.inputSchema,
          });
        }
      } catch {
        continue;
      }
    }
    return tools;
  }

  async call(runtime: AgentMcpRuntime, remoteName: string, input: unknown, signal?: AbortSignal): Promise<string> {
    if (!runtime.allowedTools.includes(remoteName)) throw new Error('MCP tool is not allowed.');
    const result = await this.client.call(runtime, remoteName, input, signal);
    return stringifyMcpResult(result);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyMcpResult(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  const content = value.content;
  if (Array.isArray(content)) {
    const text = content.flatMap((part) => {
      if (!isRecord(part)) return [];
      return typeof part.text === 'string' ? [part.text] : [];
    });
    if (text.length > 0) return text.join('\n');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return 'MCP returned an unreadable result.';
  }
}
