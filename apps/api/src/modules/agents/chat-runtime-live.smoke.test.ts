// @vitest-environment node
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb, initializeDatabase } from '@worklite/db';
import { CommandsService } from '../commands/commands.service';
import { CodexAppServerService } from './codex-app-server.service';
import { openChatRuntimeMcp } from './chat-runtime-mcp';

// Opt-in: uses the operator's logged-in Codex and one real model request. No project code or native
// session is written. The ordinary suite covers durable context and both engines without credentials.
describe.skipIf(process.env.WORKLITE_LIVE_CODEX_SMOKE !== '1')('live Codex Chat MCP smoke', () => {
  it('calls a real turn-scoped MCP tool using the native config, including a configured fast service tier', async () => {
    await mkdir(join(process.cwd(), '.data'), { recursive: true });
    const directory = await mkdtemp(join(process.cwd(), '.data/chat-codex-smoke-'));
    const db = createDb(':memory:');
    await initializeDatabase(db);
    const nonce = randomUUID();
    let calls = 0;
    const bridge = await openChatRuntimeMcp({ definitions: [{ name: 'inspect_workspace', description: 'Get the smokeNonce for this test workspace.', inputSchema: { type: 'object', additionalProperties: false } }], execute: async () => { calls++; return JSON.stringify({ smokeNonce: nonce }); } }, async () => { throw new Error('No questions in this smoke test.'); });
    try {
      const service = new CodexAppServerService(new CommandsService(db));
      const output = await service.execute({ owner: 'chat', workspaceId: 'workspace_personal', launch: await service.captureLaunch(null), model: null,
        systemPrompt: 'You are WorkLite Chat. Use the worklite_chat MCP server. Do not read or change any local files. Do not run shell commands.',
        input: 'Call worklite_chat.inspect_workspace exactly once and reply only with its smokeNonce value. Do not use any other tools.',
        projectDirectory: directory, skills: [], mcpServers: [bridge.runtime], signal: AbortSignal.timeout(120_000),
      }, { directory, systemPrompt: 'Use only the worklite_chat.inspect_workspace MCP tool. Reply with its smokeNonce. No filesystem or terminal work.', mcpServers: [{ ...bridge.runtime, key: 'worklite_chat' }] });
      expect(output).toContain(nonce);
      expect(calls).toBe(1);
    } finally {
      await bridge.close();
      db.$client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 130_000);
});
