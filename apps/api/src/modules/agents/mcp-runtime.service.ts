import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { AgentMcpRuntime } from '../teams/team-resources.service';
import { McpClientService } from '../mcp-servers/mcp-client.service';

export type McpRuntimeTool = GatewayToolDefinition & {
  serverId: string;
  serverName: string;
  remoteName: string;
};

// Anthropic (and most providers) reject a tool name over 64 characters. The server id
// is already a UUID, so the naive `mcp_<serverId>_<toolName>` scheme easily overflows
// that limit and the model call fails outright with an opaque upstream 502 — this
// happened in practice with project-info-mcp's longer tool names. A short hash of the
// server id keeps every name well under the limit while staying unique per server, and
// a tool name is only hash-suffixed if it would not fit by itself.
const MODEL_TOOL_NAME_MAX_LENGTH = 64;

function mcpModelToolName(serverId: string, toolName: string): string {
  const prefix = `mcp_${createHash('sha256').update(serverId).digest('hex').slice(0, 8)}_`;
  const budget = MODEL_TOOL_NAME_MAX_LENGTH - prefix.length;
  const sanitizedToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitizedToolName.length <= budget) return prefix + sanitizedToolName;
  const toolHash = createHash('sha256').update(toolName).digest('hex').slice(0, 8);
  return prefix + sanitizedToolName.slice(0, Math.max(0, budget - toolHash.length - 1)) + '_' + toolHash;
}

@Injectable()
export class McpRuntimeService {
  constructor(private readonly client: McpClientService) {}

  async discover(runtimes: readonly AgentMcpRuntime[], signal?: AbortSignal): Promise<McpRuntimeTool[]> {
    const tools: McpRuntimeTool[] = [];
    for (const runtime of runtimes) {
      try {
        const toolsForServer = await this.client.discover(runtime, signal);
        for (const tool of toolsForServer.filter((candidate) => runtime.allowedTools.includes(candidate.name))) {
          const modelName = mcpModelToolName(runtime.id, tool.name);
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
