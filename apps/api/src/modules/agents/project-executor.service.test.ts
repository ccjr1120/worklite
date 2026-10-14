import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectExecutorService } from './project-executor.service';
import type { ProjectExecutorRequest } from './project-executor.types';

function request(mcpServers: ProjectExecutorRequest['mcpServers']): ProjectExecutorRequest {
  return {
    owner: 'chat',
    workspaceId: 'ws',
    launch: { executor: 'claude', commandArguments: ['claude'], baseUrl: 'http://127.0.0.1:23392', model: null },
    model: null,
    systemPrompt: 'system',
    input: 'goal',
    projectDirectory: '/tmp',
    skills: [],
    mcpServers,
    signal: new AbortController().signal,
  };
}

describe('ProjectExecutorService temporary directory', () => {
  it('removes the per-task directory, including injected MCP material, after execution', async () => {
    let directory = '';
    const claude = {
      execute: async (_request: ProjectExecutorRequest, prepared: { directory: string; mcpServers: Array<{ key: string }> }) => {
        directory = prepared.directory;
        // Server ids are sanitized into stable MCP server keys.
        expect(prepared.mcpServers.map((server) => server.key)).toEqual(['worklite_mcp_abc_123']);
        await writeFile(join(directory, 'mcp.json'), '{}', { mode: 0o600 });
        return 'done';
      },
    };
    const service = new ProjectExecutorService({} as never, claude as never, {} as never, {} as never);
    const output = await service.execute(request([{ id: 'mcp.abc.123', name: 'Code Search', endpoint: 'https://mcp.example.com/search', authToken: 'secret-token', allowedTools: [] }]));
    expect(output).toBe('done');
    expect(directory).toContain('worklite-executor-chat-');
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the per-task directory when execution fails', async () => {
    let directory = '';
    const claude = {
      execute: async (_request: ProjectExecutorRequest, prepared: { directory: string }) => {
        directory = prepared.directory;
        throw new Error('executor failed');
      },
    };
    const service = new ProjectExecutorService({} as never, claude as never, {} as never, {} as never);
    await expect(service.execute(request([]))).rejects.toThrow('executor failed');
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
