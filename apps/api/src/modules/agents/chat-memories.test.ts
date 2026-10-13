import { afterEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createDb, initializeDatabase, type Database } from '@worklite/db';
import { CHAT_MEMORY_CONTENT_MAX_CHARS, CHAT_MEMORY_MAX_COUNT, CHAT_MEMORY_PROMPT_MAX_CHARS, CHAT_MEMORY_PROMPT_MAX_COUNT, ChatMemoriesService, formatChatMemoriesPrompt, selectChatMemoriesForPrompt } from './chat-memories.service';

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

async function service() {
  db = createDb(':memory:');
  await initializeDatabase(db);
  return new ChatMemoriesService(db);
}

describe('selectChatMemoriesForPrompt', () => {
  it('keeps the newest-updated order and caps the entry count', () => {
    const memories = Array.from({ length: CHAT_MEMORY_PROMPT_MAX_COUNT + 10 }, (_, index) => ({ content: `memory ${index}` }));
    const selected = selectChatMemoriesForPrompt(memories);
    expect(selected).toHaveLength(CHAT_MEMORY_PROMPT_MAX_COUNT);
    expect(selected[0].content).toBe('memory 0');
  });

  it('caps total characters and skips entries that do not fit', () => {
    const memories = [{ content: 'a'.repeat(CHAT_MEMORY_PROMPT_MAX_CHARS) }, { content: 'fits' }];
    expect(selectChatMemoriesForPrompt(memories).map((memory) => memory.content)).toEqual(['a'.repeat(CHAT_MEMORY_PROMPT_MAX_CHARS)]);
    const oversized = [{ content: 'a'.repeat(CHAT_MEMORY_PROMPT_MAX_CHARS + 1) }, { content: 'fits' }];
    expect(selectChatMemoriesForPrompt(oversized).map((memory) => memory.content)).toEqual(['fits']);
  });
});

describe('formatChatMemoriesPrompt', () => {
  it('returns an empty string when no memory is selected', () => {
    expect(formatChatMemoriesPrompt([])).toBe('');
  });

  it('lists each memory as a bullet under one header', () => {
    const prompt = formatChatMemoriesPrompt([{ content: 'prefers zh-CN' }, { content: 'uses pnpm' }]);
    expect(prompt).toContain('- prefers zh-CN');
    expect(prompt).toContain('- uses pnpm');
  });
});

describe('ChatMemoriesService', () => {
  it('saves, lists, updates and deletes memories scoped to the workspace', async () => {
    const memories = await service();
    const saved = await memories.save('workspace_personal', { content: 'prefers concise answers', sourceConversationId: 'aex_source' });
    expect(saved.id).toMatch(/^mem_/);
    expect(saved.sourceConversationId).toBe('aex_source');

    const listed = await memories.list('workspace_personal');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].content).toBe('prefers concise answers');

    const updated = await memories.update('workspace_personal', saved.id, { content: 'prefers detailed answers' });
    expect(updated.content).toBe('prefers detailed answers');

    await memories.remove('workspace_personal', saved.id);
    expect((await memories.list('workspace_personal')).items).toHaveLength(0);
  });

  it('rejects empty and oversized content', async () => {
    const memories = await service();
    await expect(memories.save('workspace_personal', { content: '  ' })).rejects.toBeInstanceOf(ConflictException);
    await expect(memories.save('workspace_personal', { content: 'a'.repeat(CHAT_MEMORY_CONTENT_MAX_CHARS + 1) })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects saving beyond the workspace memory limit', async () => {
    const memories = await service();
    for (let index = 0; index < CHAT_MEMORY_MAX_COUNT; index += 1) await memories.save('workspace_personal', { content: `memory ${index}` });
    await expect(memories.save('workspace_personal', { content: 'one too many' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not touch another workspace memory', async () => {
    const memories = await service();
    const saved = await memories.save('workspace_personal', { content: 'personal fact' });
    await expect(memories.update('workspace_other', saved.id, { content: 'hijack' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(memories.remove('workspace_other', saved.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await memories.list('workspace_personal')).items).toHaveLength(1);
  });
});
