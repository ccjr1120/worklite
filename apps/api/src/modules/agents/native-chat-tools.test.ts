import { CHAT_DELEGATION_RULE, CHAT_RULES } from '@worklite/db';
import { describe, expect, it } from 'vitest';
import type { GatewayToolDefinition } from '@worklite/model-gateway';
import { DISCOVER_CHAT_TOOLS, discoverChatTools, loadedChatToolNames, nativeChatTurnKey, nativeChatInstructions, visibleChatTools } from './native-chat-tools';

const tool = (name: string): GatewayToolDefinition => ({ name, description: 'Exact tool contract.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } });
const catalog = [DISCOVER_CHAT_TOOLS, ...['query_platform', 'run_agent', 'upload_local_images', 'upload_local_files', 'update_chat', 'wait_chat_conversation', 'custom_future_tool'].map(tool)];

describe('native Chat tool discovery', () => {
  it('starts with common tools and exposes discovery without side effects', () => {
    expect(visibleChatTools(catalog, new Set()).map((entry) => entry.name)).toEqual(['discover_tools', 'query_platform', 'run_agent']);
    const result = discoverChatTools(catalog, {}, 'turn');
    expect(result.toolNames).toEqual([]);
    expect('groups' in result ? result.groups : undefined).toContainEqual(expect.objectContaining({ name: 'files', tools: ['upload_local_files', 'upload_local_images'] }));
    expect('otherTools' in result ? result.otherTools : undefined).toContain('custom_future_tool');
  });
  it('loads groups and exact tools using unchanged schemas, with per-turn durable union', () => {
    const files = discoverChatTools(catalog, { groups: ['files'], toolNames: ['update_chat'] }, 'turn');
    const future = discoverChatTools(catalog, { toolNames: ['custom_future_tool'] }, 'turn');
    const loaded = loadedChatToolNames('turn', [JSON.stringify(files), JSON.stringify(future), 'invalid']);
    const visible = visibleChatTools(catalog, loaded);
    expect(visible.find((entry) => entry.name === 'upload_local_images')?.inputSchema).toBe(catalog.find((entry) => entry.name === 'upload_local_images')?.inputSchema);
    expect(visible.find((entry) => entry.name === 'update_chat')?.inputSchema).toBe(catalog.find((entry) => entry.name === 'update_chat')?.inputSchema);
    expect(visible).toContain(catalog.find((entry) => entry.name === 'custom_future_tool'));
    expect(visible.some((entry) => entry.name === 'wait_chat_conversation')).toBe(false);
    expect(loadedChatToolNames('next-turn', [JSON.stringify(files)]).size).toBe(0);
    expect(visibleChatTools(catalog.slice(0, 2), loaded).map((tool) => tool.name)).toEqual(catalog.slice(0, 2).map((tool) => tool.name));
  });
  it.each([{ ruleTopics: ['unknown'] }, { ruleTopics: null }, { ruleTopics: 'agents' }, { ruleTopics: ['agents', 'files', 'chat', 'usage', 'memory'] }, { groups: ['unknown'] }, { groups: 'files' }, { groups: null }, { toolNames: ['unassigned'] }, { toolNames: [1] }, { execute: true }, [], null])('rejects invalid discovery atomically (%j)', (input) => {
    expect(() => discoverChatTools(catalog, input, 'turn')).toThrow();
  });
  it('cannot restore removed tools from old discovery results or prompt snapshots', () => {
    const oldCatalog = [...catalog, tool('web_fetch'), tool('update_plan')];
    const loaded = new Set(['web_fetch', 'update_plan']);
    expect(visibleChatTools(oldCatalog, loaded).some((entry) => loaded.has(entry.name))).toBe(false);
    expect(JSON.stringify(discoverChatTools(oldCatalog, {}, 'turn'))).not.toMatch(/web_fetch|update_plan/);
    for (const name of loaded) expect(() => discoverChatTools(oldCatalog, { toolNames: [name] }, 'turn')).toThrow('unavailable');
    expect(nativeChatInstructions('Read public page URLs with web_fetch. Other instructions. web_fetch reads public page URLs directly.')).not.toContain('web_fetch');
  });
  it('lists rule topics without rule bodies, and can read every topic without loading tools', () => {
    const index = discoverChatTools(catalog, {}, 'turn');
    expect(index.rules).toEqual([]);
    expect(JSON.stringify(index)).not.toContain(CHAT_DELEGATION_RULE);
    for (const topic of Object.keys(CHAT_RULES)) {
      const result = discoverChatTools(catalog, { ruleTopics: [topic] }, 'turn');
      expect(result.toolNames).toEqual([]);
      expect(result.rules.find((rule) => rule.topic === topic)?.content).toBe(nativeChatInstructions(CHAT_RULES[topic as keyof typeof CHAT_RULES].content));
    }
  });
  it('loads relevant rules with tools and uses captured references when available', () => {
    const result = discoverChatTools(catalog, { toolNames: ['run_agent'] }, 'turn', { agents: 'Captured Agent rules.' });
    expect(result.rules).toContainEqual({ topic: 'agents', content: 'Captured Agent rules.' });
    expect(result.rules.map((rule) => rule.topic)).toEqual(['agents', 'terminal', 'tooling']);
    const legacy = discoverChatTools(catalog, { ruleTopics: ['agents'] }, 'turn');
    expect(legacy.rules.find((rule) => rule.topic === 'agents')?.content).toContain(CHAT_DELEGATION_RULE);
    expect(visibleChatTools(catalog, new Set()).find((tool) => tool.name === 'run_agent')?.description).toContain('ruleTopics: agents, terminal');
  });
  it('keeps the display user id stable across compaction and separates queued turns', () => {
    const execution = { displayMessages: [{ id: 'user1', role: 'user' }], modelMessages: [{ role: 'user', content: 'goal' }] };
    expect(nativeChatTurnKey(execution)).toBe(nativeChatTurnKey({ ...execution, modelMessages: [{ role: 'user', content: 'checkpoint' }] }));
    expect(nativeChatTurnKey({ ...execution, displayMessages: [...execution.displayMessages, { id: 'queued_user2', role: 'user' }] })).toBe('queued_user2');
    expect(nativeChatTurnKey({ ...execution, displayMessages: [] })).toBe(nativeChatTurnKey({ ...execution, displayMessages: [] }));
  });
});
