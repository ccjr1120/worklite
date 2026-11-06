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

describe('ProjectExecutorService.captureLaunch', () => {
  it('captures Codex through the built-in adapter without plugin configuration', async () => {
    const launch = { executor: 'codex', commandArguments: ['codex'], model: 'provider/model' };
    const codex = { captureLaunch: async (model: string | null) => { expect(model).toBe('provider/model'); return launch; } };
    const service = new ProjectExecutorService(codex as never, {} as never, {} as never);
    expect(await service.captureLaunch('codex', 'provider/model')).toBe(launch);
  });
});

describe('ProjectExecutorService.requireModel', () => {
  it('never calls the Gateway for Codex: it is not required to use a Gateway model', async () => {
    const resources = { publicModelRuntime: () => { throw new Error('must not be called for codex'); } };
    const service = new ProjectExecutorService({} as never, {} as never, resources as never);
    await expect(service.requireModel('ws', 'codex', 'gpt-6-luna')).resolves.toBeUndefined();
  });

  it('still validates Claude Code against the Gateway protocol', async () => {
    const resources = { publicModelRuntime: async () => ({ protocol: 'openai/chat' }) };
    const service = new ProjectExecutorService({} as never, {} as never, resources as never);
    await expect(service.requireModel('ws', 'claude', 'some/model')).rejects.toThrow('Claude Code 需要');
  });
});

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
    const service = new ProjectExecutorService({} as never, claude as never, {} as never);
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
    const service = new ProjectExecutorService({} as never, claude as never, {} as never);
    await expect(service.execute(request([]))).rejects.toThrow('executor failed');
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
