import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { resolveClaudeMcpServers } from './claude-code.service';
import { codexMcpServers } from './codex-app-server.service';
import type { PreparedProjectExecution } from './project-executor.types';
import { teamMemoryMcpRuntime } from '../coders/coder-memory-mcp';

// A v11 project executor receives the Coder memory MCP server like any other MCP
// server: Claude Code through the SDK's own mcpServers option and Codex through
// mcp_servers.<key>. Discovery failures are logged, not silently dropped.

function preparedTeamMemory(): PreparedProjectExecution {
  const runtime = teamMemoryMcpRuntime('wtm_coder_token');
  return {
    directory: '/tmp/unused',
    systemPrompt: 'system',
    mcpServers: [{ ...runtime, key: `worklite_${runtime.id}` }],
  };
}

describe('Coder memory MCP injection', () => {
  it('resolves the Coder memory server into the Claude SDK mcpServers config', async () => {
    const prepared = preparedTeamMemory();
    const { config, disallowedTools } = await resolveClaudeMcpServers(prepared, async () => [
      { name: 'coder_memory_search' },
      { name: 'coder_memory_read' },
      { name: 'coder_memory_write' },
    ]);

    expect(config?.worklite_coder_memory).toEqual({
      type: 'http',
      url: prepared.mcpServers[0]!.endpoint,
      headers: { Authorization: 'Bearer wtm_coder_token' },
    });
    expect(disallowedTools).toEqual([]);
  });

  it('adds mcp_servers.worklite_coder_memory for Codex with its bearer environment variable', () => {
    const prepared = preparedTeamMemory();
    const { config, env } = codexMcpServers(prepared, false);

    expect(config['mcp_servers.worklite_coder_memory']).toEqual({
      url: prepared.mcpServers[0]!.endpoint,
      enabled_tools: ['coder_memory_search', 'coder_memory_read', 'coder_memory_write'],
      bearer_token_env_var: 'WORKLITE_MCP_TOKEN_0',
    });
    expect(env.WORKLITE_MCP_TOKEN_0).toBe('wtm_coder_token');
  });

  it('logs a warning when discovery fails instead of injecting an unvetted server silently', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const prepared = preparedTeamMemory();
      const { config, disallowedTools } = await resolveClaudeMcpServers(prepared, async () => {
        throw new Error('connect ECONNREFUSED');
      });

      expect(config).toBeUndefined();
      expect(disallowedTools).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('worklite_coder_memory'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    } finally {
      warn.mockRestore();
    }
  });
});
