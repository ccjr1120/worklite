import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { AgentMcpRuntime } from '../teams/team-resources.service';

export type McpRuntimeTool = GatewayToolDefinition & {
  serverId: string;
  serverName: string;
  remoteName: string;
};

@Injectable()
export class McpRuntimeService {
  async discover(runtimes: readonly AgentMcpRuntime[], signal?: AbortSignal): Promise<McpRuntimeTool[]> {
    const tools: McpRuntimeTool[] = [];
    for (const runtime of runtimes) {
      try {
        await this.request(runtime, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'worklite', version: '0.0.0' } }, signal);
        await this.request(runtime, 'notifications/initialized', {}, signal).catch(() => undefined);
        const result = await this.request(runtime, 'tools/list', {}, signal);
        const values = result?.tools;
        if (!Array.isArray(values)) continue;
        for (const value of values.slice(0, runtime.allowedTools > 0 ? runtime.allowedTools : 0)) {
          if (!value || typeof value !== 'object') continue;
          const record = value as Record<string, unknown>;
          if (typeof record.name !== 'string' || !record.name.trim()) continue;
          const modelName = `mcp_${runtime.id}_${record.name}`;
          tools.push({
            name: modelName,
            remoteName: record.name,
            serverId: runtime.id,
            serverName: runtime.name,
            description: typeof record.description === 'string' ? record.description : `Call ${record.name} on ${runtime.name}.`,
            inputSchema: isRecord(record.inputSchema) ? record.inputSchema : { type: 'object', additionalProperties: true },
          });
        }
      } catch {
        continue;
      }
    }
    return tools;
  }

  async call(runtime: AgentMcpRuntime, remoteName: string, input: unknown, signal?: AbortSignal): Promise<string> {
    await this.request(runtime, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'worklite', version: '0.0.0' } }, signal);
    await this.request(runtime, 'notifications/initialized', {}, signal).catch(() => undefined);
    const result = await this.request(runtime, 'tools/call', { name: remoteName, arguments: isRecord(input) ? input : {} }, signal);
    return stringifyMcpResult(result);
  }

  private async request(runtime: AgentMcpRuntime, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    if (runtime.authToken) headers.Authorization = `Bearer ${runtime.authToken}`;
    const notification = method.startsWith('notifications/');
    const response = await fetch(runtime.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: randomUUID() }), method, params }),
      signal,
    });
    if (!response.ok) throw new Error(`MCP request failed with status ${response.status}.`);
    if (notification) return {};
    const payload = await response.text();
    const parsed = parseJsonOrSse(payload);
    if (parsed.error) throw new Error('MCP server returned an error.');
    const result = parsed.result;
    return isRecord(result) ? result : {};
  }
}

function parseJsonOrSse(payload: string): Record<string, unknown> {
  const candidates = payload.trim().startsWith('data:')
    ? payload.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
    : [payload.trim()];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index] ?? '') as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  throw new Error('MCP server returned invalid JSON.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyMcpResult(value: Record<string, unknown>): string {
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
