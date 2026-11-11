import { describe, expect, it, vi } from 'vitest';
import type { GatewayAgentMessage } from '@worklite/model-gateway';
import { compactNativeContext, isContextLimitError } from './native-context';

const messages: GatewayAgentMessage[] = [
  { role: 'user', content: 'Original goal' },
  { role: 'assistant', content: [{ type: 'text', text: 'Old evidence '.repeat(8000) }] },
  { role: 'user', content: 'Latest exact requirement' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't', toolName: 'inspect', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName: 'inspect', output: { type: 'text', value: 'verified' } }] },
];
const input = () => ({ messages, systemPrompt: 'system', tools: [], archiveId: 'archive', maxTokens: 8192, signal: new AbortController().signal, summarize: vi.fn(async () => 'Verified progress; original goal remains pending.') });

describe('native context compaction', () => {
  it('retains the latest instruction and complete recent tool exchange with an archive reference', async () => {
    const options = input();
    const result = await compactNativeContext(options);
    expect(result?.messages.slice(1)).toEqual(messages.slice(2));
    expect(result?.messages[0].content).toContain('archive');
    expect(options.summarize).toHaveBeenCalled();
    expect(messages[1].content).toEqual([{ type: 'text', text: 'Old evidence '.repeat(8000) }]);
  });
  it('does no work below threshold and compacts only when forced by a provider context error', async () => {
    const options = { ...input(), maxTokens: 100000 };
    expect(await compactNativeContext(options)).toBeNull();
    expect(options.summarize).not.toHaveBeenCalled();
    expect(await compactNativeContext({ ...options, force: true })).not.toBeNull();
  });
  it('never substitutes an empty summary or loses an oversized latest instruction', async () => {
    await expect(compactNativeContext({ ...input(), summarize: async () => '' })).rejects.toThrow('empty');
    await expect(compactNativeContext({ ...input(), messages: [...messages, { role: 'user', content: 'x'.repeat(100000) }] })).rejects.toThrow('latest user instruction');
  });
  it('honors cancellation during summary work', async () => {
    const controller = new AbortController();
    await expect(compactNativeContext({ ...input(), signal: controller.signal, summarize: async () => { controller.abort(); return 'summary'; } })).rejects.toBeDefined();
  });
  it('distinguishes context limits from quota and unrelated invalid requests', () => {
    expect(isContextLimitError(new Error('HTTP 400: maximum context length exceeded'))).toBe(true);
    expect(isContextLimitError(new Error('wrapper', { cause: new Error('prompt is too long') }))).toBe(true);
    expect(isContextLimitError(new Error('HTTP 429 weekly quota exceeded'))).toBe(false);
    expect(isContextLimitError(new Error('HTTP 400 invalid schema'))).toBe(false);
  });
});
