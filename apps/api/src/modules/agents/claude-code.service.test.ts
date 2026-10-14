import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandExecutionView } from '@worklite/contracts';
import type { CommandStdioProcess } from '../commands/commands.service';
import { ClaudeCodeService } from './claude-code.service';
import type { PreparedProjectExecution, ProjectExecutorRequest } from './project-executor.types';

// A fake stdio transport that speaks just enough of the Claude Code control protocol: it answers
// initialize, emits the system init event, and settles the turn with a result once the user message arrives.
class FakeClaudeTransport {
  argv: string[] = [];
  private completionResolve!: (view: CommandExecutionView) => void;

  constructor(private readonly version = '2.1.259') {}

  async open(argv: string[], onEvent: (event: { type: string; data: string }) => void): Promise<CommandStdioProcess> {
    this.argv = [...argv];
    const emit = (message: unknown) => onEvent({ type: 'stdout', data: `${JSON.stringify(message)}\n` });
    const completion = new Promise<CommandExecutionView>((resolve) => { this.completionResolve = resolve; });
    return {
      executionId: 'cmd_fake',
      completion,
      write: async (data: string) => {
        const message = JSON.parse(data) as { type: string; request_id?: string; request?: { subtype?: string } };
        if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
          emit({ type: 'system', subtype: 'init', session_id: 'session_fake', claude_code_version: this.version });
          emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
          return;
        }
        if (message.type === 'user') {
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] }, parent_tool_use_id: null });
          emit({ type: 'result', subtype: 'success', is_error: false, result: '{"status":"succeeded","summary":"ok"}' });
        }
      },
      close: async () => { this.completionResolve({ status: 'succeeded' } as CommandExecutionView); },
    };
  }
}

function buildExecution(directory: string, mcpServers: PreparedProjectExecution['mcpServers']): { request: ProjectExecutorRequest; prepared: PreparedProjectExecution } {
  return {
    request: {
      owner: 'chat',
      workspaceId: 'ws',
      launch: { executor: 'claude', commandArguments: ['claude'], baseUrl: 'http://127.0.0.1:23392', model: null, modelSource: 'executor' },
      model: null,
      systemPrompt: 'system',
      input: 'goal',
      projectDirectory: directory,
      skills: [],
      mcpServers: [],
      signal: new AbortController().signal,
    },
    prepared: { directory, systemPrompt: 'system', mcpServers },
  };
}

describe('ClaudeCodeService MCP injection', () => {
  let directory: string;
  let transport: FakeClaudeTransport;
  let service: ClaudeCodeService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'worklite-claude-test-'));
    transport = new FakeClaudeTransport();
    const commands = { openStdioProcess: (argv: string[], _cwd: string, _env: unknown, onEvent: (event: { type: string; data: string }) => void) => transport.open(argv, onEvent), cancel: async () => ({}) };
    const mcp = { discover: async () => [{ name: 'search' }, { name: 'read' }] };
    service = new ClaudeCodeService(commands as never, mcp as never);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('launches without MCP arguments when no server is injected', async () => {
    const { request, prepared } = buildExecution(directory, []);
    await expect(service.execute(request, prepared)).resolves.toBe('{"status":"succeeded","summary":"ok"}');
    expect(transport.argv).not.toContain('--mcp-config');
    expect(transport.argv).not.toContain('--disallowedTools');
    await expect(stat(join(directory, 'mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes an owner-only mcp-config and passes it with the captured allowlist', async () => {
    const { request, prepared } = buildExecution(directory, [
      { id: 'mcp_1', name: 'Code Search', key: 'worklite_mcp_1', endpoint: 'https://mcp.example.com/search', authToken: 'secret-token', allowedTools: ['search'] },
    ]);
    await service.execute(request, prepared);
    const flagIndex = transport.argv.indexOf('--mcp-config');
    expect(flagIndex).toBeGreaterThan(-1);
    const configPath = transport.argv[flagIndex + 1];
    expect(configPath).toBe(join(directory, 'mcp.json'));
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: { worklite_mcp_1: { type: 'http', url: 'https://mcp.example.com/search', headers: { Authorization: 'Bearer secret-token' } } },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    // Tools outside the captured allowlist are disallowed by name.
    const disallowedIndex = transport.argv.indexOf('--disallowedTools');
    expect(disallowedIndex).toBeGreaterThan(-1);
    expect(transport.argv.slice(disallowedIndex + 1)).toEqual(['mcp__worklite_mcp_1__read']);
    // Credentials travel only inside the owner-only file, never in command arguments.
    expect(transport.argv.some((argument) => argument.includes('secret-token'))).toBe(false);
  });

  it('omits the Authorization header when the server has no credential', async () => {
    const { request, prepared } = buildExecution(directory, [
      { id: 'mcp_2', name: 'Open', key: 'worklite_mcp_2', endpoint: 'https://mcp.example.com/open', allowedTools: ['search', 'read'] },
    ]);
    await service.execute(request, prepared);
    const configPath = transport.argv[transport.argv.indexOf('--mcp-config') + 1];
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcpServers: { worklite_mcp_2: { type: 'http', url: 'https://mcp.example.com/open' } },
    });
    expect(transport.argv).not.toContain('--disallowedTools');
  });

  it('skips a server whose tool discovery fails', async () => {
    const commands = { openStdioProcess: (argv: string[], _cwd: string, _env: unknown, onEvent: (event: { type: string; data: string }) => void) => transport.open(argv, onEvent), cancel: async () => ({}) };
    const mcp = { discover: async () => { throw new Error('unreachable'); } };
    service = new ClaudeCodeService(commands as never, mcp as never);
    const { request, prepared } = buildExecution(directory, [
      { id: 'mcp_3', name: 'Down', key: 'worklite_mcp_3', endpoint: 'https://mcp.example.com/down', allowedTools: ['search'] },
    ]);
    await service.execute(request, prepared);
    expect(transport.argv).not.toContain('--mcp-config');
  });
});
