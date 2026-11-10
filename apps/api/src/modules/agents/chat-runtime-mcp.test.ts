// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openChatRuntimeMcp } from './chat-runtime-mcp';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function setup() {
  const execute = vi.fn(async (name: string, input: Record<string, unknown>, ask: (question: string) => Promise<string>) => name === 'ask_user' ? ask(String(input.question)) : JSON.stringify(input));
  const server = await openChatRuntimeMcp({ definitions: ['inspect_workspace', 'ask_user'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })), execute }, async (question) => `Answer: ${question}`);
  cleanup.push(server.close);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.runtime.endpoint), { requestInit: { headers: { authorization: `Bearer ${server.runtime.authToken}` } } }));
  cleanup.push(() => client.close());
  return { client, server, execute };
}

describe('turn-scoped Chat MCP bridge', () => {
  it('lists captured tools and routes arguments and a live answer through MCP', async () => {
    const { client } = await setup();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['inspect_workspace', 'ask_user']);
    expect(await client.callTool({ name: 'inspect_workspace', arguments: { value: 'yes' } })).toMatchObject({ content: [{ type: 'text', text: '{"value":"yes"}' }] });
    expect(await client.callTool({ name: 'ask_user', arguments: { question: 'Which?' } })).toMatchObject({ content: [{ type: 'text', text: 'Answer: Which?' }] });
  });

  it('rejects missing credentials and undeclared tools without executing them', async () => {
    const { client, server, execute } = await setup();
    expect((await fetch(server.runtime.endpoint, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(await client.callTool({ name: 'other_conversation', arguments: {} })).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });
});
