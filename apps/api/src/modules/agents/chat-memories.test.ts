import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createDb, initializeDatabase, type Database } from '@worklite/db';
import { buildChatMemoriesPrompt, CHAT_MEMORY_CATALOG_MAX_CHARS, CHAT_MEMORY_CATALOG_SUMMARY_CHARS, CHAT_MEMORY_CONTENT_MAX_CHARS, CHAT_MEMORY_MAX_COUNT, CHAT_MEMORY_PROMPT_MAX_CHARS, CHAT_MEMORY_PROMPT_MAX_COUNT, ChatMemoriesService, chatMemoryCatalogSummary, formatChatMemoriesPrompt, selectChatMemoriesForPrompt } from './chat-memories.service';

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

  it('defaults new memories to the preference category and lists them with it', async () => {
    const memories = await service();
    const saved = await memories.save('workspace_personal', { content: 'prefers zh-CN' });
    expect(saved.category).toBe('preference');
    expect((await memories.list('workspace_personal')).items[0].category).toBe('preference');
  });

  it('saves and updates the category, filters the list by it and reads one entry by id', async () => {
    const memories = await service();
    const rule = await memories.save('workspace_personal', { content: 'never scan company/*', category: 'rule' });
    const project = await memories.save('workspace_personal', { content: 'project index', category: 'project' });
    expect(rule.category).toBe('rule');

    const filtered = await memories.list('workspace_personal', { category: 'project' });
    expect(filtered.items.map((item) => item.id)).toEqual([project.id]);

    const fetched = await memories.get('workspace_personal', project.id);
    expect(fetched.content).toBe('project index');
    await expect(memories.get('workspace_other', project.id)).rejects.toBeInstanceOf(NotFoundException);

    const recategorized = await memories.update('workspace_personal', project.id, { category: 'project_state' });
    expect(recategorized.category).toBe('project_state');
    expect(recategorized.content).toBe('project index');
  });

  it('rejects an unknown category and an empty update', async () => {
    const memories = await service();
    const saved = await memories.save('workspace_personal', { content: 'fact' });
    await expect(memories.save('workspace_personal', { content: 'bad', category: 'unknown' as never })).rejects.toBeInstanceOf(ConflictException);
    await expect(memories.update('workspace_personal', saved.id, { category: 'unknown' as never })).rejects.toBeInstanceOf(ConflictException);
    await expect(memories.update('workspace_personal', saved.id, {})).rejects.toBeInstanceOf(ConflictException);
    await expect(memories.list('workspace_personal', { category: 'unknown' as never })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('buildChatMemoriesPrompt', () => {
  it('injects rule and preference content in full and keeps other categories as an id catalog', () => {
    const prompt = buildChatMemoriesPrompt([
      { id: 'mem_rule', content: 'always follow the branch rule', category: 'rule' },
      { id: 'mem_pref', content: 'prefers concise answers', category: 'preference' },
      { id: 'mem_project', content: 'project index\nalpha and beta full detail', category: 'project' },
      { id: 'mem_state', content: 'alpha blocked\nfull CI detail', category: 'project_state' },
      { id: 'mem_flow', content: 'weekly writing workflow\nfull workflow detail', category: 'workflow' },
      { id: 'mem_other', content: 'misc note\nfull misc detail', category: 'other' },
    ]);
    expect(prompt).toContain('- always follow the branch rule');
    expect(prompt).toContain('- prefers concise answers');
    expect(prompt).not.toContain('alpha and beta full detail');
    expect(prompt).not.toContain('full CI detail');
    expect(prompt).not.toContain('full workflow detail');
    expect(prompt).not.toContain('full misc detail');
    expect(prompt).toContain('- [project] mem_project: project index');
    expect(prompt).toContain('- [project_state] mem_state: alpha blocked');
    expect(prompt).toContain('- [workflow] mem_flow: weekly writing workflow');
    expect(prompt).toContain('- [other] mem_other: misc note');
    expect(prompt).toContain('list_memories');
  });

  it('returns an empty string when there is nothing to inject', () => {
    expect(buildChatMemoriesPrompt([])).toBe('');
  });

  it('renders only the catalog when no always-injected memory exists', () => {
    const prompt = buildChatMemoriesPrompt([{ id: 'mem_project', content: 'project index', category: 'project' }]);
    expect(prompt).not.toContain('always apply');
    expect(prompt).toContain('- [project] mem_project: project index');
  });

  it('bounds the catalog by total characters and stops at the cap', () => {
    const memories = Array.from({ length: 40 }, (_, index) => ({
      id: `mem_${String(index).padStart(3, '0')}`,
      content: `summary ${'y'.repeat(CHAT_MEMORY_CATALOG_SUMMARY_CHARS)}`,
      category: 'project' as const,
    }));
    const prompt = buildChatMemoriesPrompt(memories);
    const catalogLines = prompt.split('\n').filter((line) => line.startsWith('- [project]'));
    expect(catalogLines.length).toBeGreaterThan(0);
    expect(catalogLines.length).toBeLessThan(memories.length);
    expect(catalogLines.reduce((total, line) => total + line.length, 0)).toBeLessThanOrEqual(CHAT_MEMORY_CATALOG_MAX_CHARS);
  });

  it('truncates the catalog summary to one bounded line', () => {
    const long = `first line ${'y'.repeat(CHAT_MEMORY_CATALOG_SUMMARY_CHARS)}\nsecond line`;
    const summary = chatMemoryCatalogSummary(long);
    expect(summary.length).toBeLessThanOrEqual(CHAT_MEMORY_CATALOG_SUMMARY_CHARS + 1);
    expect(summary).not.toContain('second line');
  });
});

describe('migration 0042_chat_memory_categories', () => {
  it('adds the category column with the other default and classifies the known memories by id prefix', () => {
    db = createDb(':memory:');
    // The pre-0042 table shape from 0033_chat_memories.sql.
    db.$client.exec(`CREATE TABLE chat_memories (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      content text NOT NULL,
      source_conversation_id text,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL,
      updated_at integer DEFAULT (unixepoch() * 1000) NOT NULL
    )`);
    const insert = db.$client.prepare(`INSERT INTO chat_memories (id, workspace_id, content) VALUES (?, 'workspace_personal', ?)`);
    insert.run('mem_90e07fe0-de2b-429b-a6d3-f19f396c122f', 'branch rule');
    insert.run('mem_1f9756c6-199e-4914-b27b-f7d93dd0e77a', 'dispatch routing rule');
    insert.run('mem_00fe67ea-2510-4b69-8aa0-945b1ca43d20', 'scan exclusion rule');
    insert.run('mem_c83a161c-dac7-4571-9066-33319d3e82dc', 'project lookup flow rule');
    insert.run('mem_2f119b66-be33-4033-a660-d8683701ee8c', 'project index');
    insert.run('mem_ffffffff-0000-0000-0000-000000000000', 'unrelated legacy entry');

    const migrationPath = [resolve(process.cwd(), 'packages/db/drizzle/0042_chat_memory_categories.sql'), resolve(process.cwd(), '../../packages/db/drizzle/0042_chat_memory_categories.sql')].find((candidate) => existsSync(candidate));
    if (!migrationPath) throw new Error('Migration file could not be located.');
    for (const statement of readFileSync(migrationPath, 'utf8').split('--> statement-breakpoint')) {
      const sql = statement.trim();
      if (sql) db.$client.exec(sql);
    }

    const rows = db.$client.prepare(`SELECT id, category FROM chat_memories`).all() as Array<{ id: string; category: string }>;
    const byId = new Map(rows.map((row) => [row.id, row.category]));
    expect(byId.get('mem_90e07fe0-de2b-429b-a6d3-f19f396c122f')).toBe('rule');
    expect(byId.get('mem_1f9756c6-199e-4914-b27b-f7d93dd0e77a')).toBe('rule');
    expect(byId.get('mem_00fe67ea-2510-4b69-8aa0-945b1ca43d20')).toBe('rule');
    expect(byId.get('mem_c83a161c-dac7-4571-9066-33319d3e82dc')).toBe('rule');
    expect(byId.get('mem_2f119b66-be33-4033-a660-d8683701ee8c')).toBe('project');
    expect(byId.get('mem_ffffffff-0000-0000-0000-000000000000')).toBe('other');
  });

  it('migrates a fresh database through initializeDatabase with the category column', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const columns = db.$client.prepare(`PRAGMA table_info(chat_memories)`).all() as Array<{ name: string; dflt_value: string }>;
    const category = columns.find((column) => column.name === 'category');
    expect(category).toBeDefined();
    expect(category?.dflt_value).toBe(`'other'`);
  });
});
