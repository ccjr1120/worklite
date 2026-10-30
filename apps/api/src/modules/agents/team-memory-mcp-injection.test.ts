import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeMcpConfiguration } from './claude-code.service';
import { codexMcpServers } from './codex-app-server.service';
import type { PreparedProjectExecution } from './project-executor.types';
import { teamMemoryMcpRuntime } from '../coders/coder-memory-mcp';

// A v11 project executor receives the Coder memory MCP server like any other MCP
// server: Claude Code through the owner-only mcp.json and Codex through
// mcp_servers.<key>. Discovery failures are logged, not silently dropped.

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'worklite-team-memory-mcp-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function preparedTeamMemory(): PreparedProjectExecution {
  const runtime = teamMemoryMcpRuntime('wtm_coder_token');
  return {
    directory,
    systemPrompt: 'system',
    mcpServers: [{ ...runtime, key: `worklite_${runtime.id}` }],
  };
}

describe('Coder memory MCP injection', () => {
  it('adds the Coder memory server to the Claude mcp.json', async () => {
    const prepared = preparedTeamMemory();
    const argv = await writeClaudeMcpConfiguration(prepared.directory, prepared.mcpServers, async () => [
      { name: 'coder_memory_search' },
      { name: 'coder_memory_read' },
      { name: 'coder_memory_write' },
    ]);

    expect(argv).toEqual(['--mcp-config', join(directory, 'mcp.json')]);
    const config = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
    };
    expect(config.mcpServers.worklite_coder_memory).toEqual({
      type: 'http',
      url: prepared.mcpServers[0]!.endpoint,
      headers: { Authorization: 'Bearer wtm_coder_token' },
    });
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
      const argv = await writeClaudeMcpConfiguration(prepared.directory, prepared.mcpServers, async () => {
        throw new Error('connect ECONNREFUSED');
      });

      expect(argv).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('worklite_coder_memory'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    } finally {
      warn.mockRestore();
    }
  });
});
