// @vitest-environment node
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { McpClientService } from '../mcp-servers/mcp-client.service';
import { ClaudeCodeService } from './claude-code.service';
import { openChatRuntimeMcp } from './chat-runtime-mcp';

const location = vi.hoisted(() => ({ home: '' }));
// Keep SDK configuration artifacts inside this repository during the live smoke.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => location.home || os.homedir() };
});

describe.skipIf(!process.env.WORKLITE_LIVE_CLAUDE_MODEL)('live Claude Chat MCP smoke', () => {
  it('calls the scoped MCP tool through the real Agent SDK and a configured Gateway model', async () => {
    await mkdir(join(process.cwd(), '.data'), { recursive: true });
    const directory = await mkdtemp(join(process.cwd(), '.data/chat-claude-smoke-'));
    location.home = directory;
    const model = process.env.WORKLITE_LIVE_CLAUDE_MODEL!;
    const nonce = randomUUID();
    let calls = 0;
    const bridge = await openChatRuntimeMcp({ definitions: [{ name: 'inspect_workspace', description: 'Read the smokeNonce for this workspace.', inputSchema: { type: 'object', additionalProperties: false } }], execute: async () => { calls++; return JSON.stringify({ smokeNonce: nonce }); } }, async () => { throw new Error('No questions in this smoke test.'); });
    try {
      const service = new ClaudeCodeService(new McpClientService());
      let sessionId: string | undefined;
      const invoke = async (input: string) => service.execute({ owner: 'chat', workspaceId: 'workspace_personal', launch: await service.captureLaunch(model), model,
        runtimeSession: { resumeId: sessionId, onSession: async (id) => { sessionId = id; } },
        systemPrompt: 'You are WorkLite Chat. Use only the worklite_chat MCP tool. Do not read or change local files, do not run shell commands.', input,
        projectDirectory: directory, skills: [], mcpServers: [bridge.runtime], signal: AbortSignal.timeout(120_000),
      }, { directory, systemPrompt: 'Use the worklite_chat MCP server for this request. No filesystem or terminal work.', mcpServers: [{ ...bridge.runtime, key: 'worklite_chat' }] });
      const output = await invoke('Call mcp__worklite_chat__inspect_workspace exactly once and reply only with its smokeNonce value. Do not use any other tools.');
      expect(output).toContain(nonce);
      expect(sessionId).toBeTruthy();
      const resumed = await invoke('Reply only with the smokeNonce you observed in the preceding turn. Do not call any tools this turn.');
      expect(resumed).toContain(nonce);
      expect(calls).toBe(1);
    } finally {
      await bridge.close();
      location.home = '';
      await rm(directory, { recursive: true, force: true });
    }
  }, 130_000);
});
