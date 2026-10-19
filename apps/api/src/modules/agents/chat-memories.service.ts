import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { CHAT_MEMORY_CATEGORIES, CHAT_MEMORY_CATEGORY_META, CHAT_MEMORY_DEFAULT_CATEGORY, type ChatMemoryCategory, type ChatMemoryList, type ChatMemoryView, type SaveChatMemoryRequest, type UpdateChatMemoryRequest } from '@worklite/contracts';
import { chatMemories, type ChatMemory, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

export const CHAT_MEMORY_CONTENT_MAX_CHARS = 2000;
export const CHAT_MEMORY_MAX_COUNT = 100;
export const CHAT_MEMORY_PROMPT_MAX_COUNT = 50;
export const CHAT_MEMORY_PROMPT_MAX_CHARS = 6000;
export const CHAT_MEMORY_CATALOG_MAX_COUNT = 50;
export const CHAT_MEMORY_CATALOG_MAX_CHARS = 2000;
export const CHAT_MEMORY_CATALOG_SUMMARY_CHARS = 80;

// Bounded prompt projection: newest-updated first, capped by count and total characters.
export function selectChatMemoriesForPrompt<T extends { content: string }>(memories: T[], maxCount = CHAT_MEMORY_PROMPT_MAX_COUNT, maxChars = CHAT_MEMORY_PROMPT_MAX_CHARS): T[] {
  const selected: T[] = [];
  let chars = 0;
  for (const memory of memories) {
    if (selected.length >= maxCount) break;
    if (chars + memory.content.length > maxChars) continue;
    selected.push(memory);
    chars += memory.content.length;
  }
  return selected;
}

export function formatChatMemoriesPrompt(memories: Array<{ content: string }>): string {
  if (memories.length === 0) return '';
  return ['Long-term memories saved from earlier conversations; apply them naturally to this conversation:', ...memories.map((memory) => `- ${memory.content}`)].join('\n');
}

// One-line catalog summary for an on-demand memory: its first line, truncated.
export function chatMemoryCatalogSummary(content: string): string {
  const firstLine = content.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine.length > CHAT_MEMORY_CATALOG_SUMMARY_CHARS ? `${firstLine.slice(0, CHAT_MEMORY_CATALOG_SUMMARY_CHARS)}…` : firstLine;
}

// Prompt partition: rule and preference categories stay fully injected exactly as before;
// every other category appears only as a bounded id/category/summary catalog the model reads on demand.
export function buildChatMemoriesPrompt(memories: Array<{ id: string; content: string; category: ChatMemoryCategory }>): string {
  const always = selectChatMemoriesForPrompt(memories.filter((memory) => CHAT_MEMORY_CATEGORY_META[memory.category]?.injection === 'always'));
  const catalogEntries = memories.filter((memory) => CHAT_MEMORY_CATEGORY_META[memory.category]?.injection !== 'always')
    .map((memory) => `- [${memory.category}] ${memory.id}: ${chatMemoryCatalogSummary(memory.content)}`);
  const catalog: string[] = [];
  let catalogChars = 0;
  for (const entry of catalogEntries) {
    if (catalog.length >= CHAT_MEMORY_CATALOG_MAX_COUNT) break;
    if (catalogChars + entry.length > CHAT_MEMORY_CATALOG_MAX_CHARS) continue;
    catalog.push(entry);
    catalogChars += entry.length;
  }
  const sections: string[] = [];
  if (always.length > 0) sections.push(['Long-term memory rules and preferences saved from earlier conversations; always apply them naturally to this conversation:', ...always.map((memory) => `- ${memory.content}`)].join('\n'));
  if (catalog.length > 0) sections.push(['More long-term memories are available on demand. Each line shows a memory category, id and summary; read the full text with list_memories (filter by category or pass memoryId) before relying on it. When a request names a specific project or involves development, debugging, research or deployment work, read the project-category memories first:', ...catalog].join('\n'));
  return sections.join('\n\n');
}

const toView = (row: ChatMemory): ChatMemoryView => ({
  id: row.id,
  content: row.content,
  category: row.category,
  sourceConversationId: row.sourceConversationId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class ChatMemoriesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(workspaceId: string, filter: { category?: ChatMemoryCategory } = {}): Promise<ChatMemoryList> {
    const category = this.validateCategory(filter.category);
    const rows = await this.db.select().from(chatMemories)
      .where(category ? and(eq(chatMemories.workspaceId, workspaceId), eq(chatMemories.category, category)) : eq(chatMemories.workspaceId, workspaceId))
      .orderBy(desc(chatMemories.updatedAt));
    return { items: rows.map(toView) };
  }

  async get(workspaceId: string, id: string): Promise<ChatMemoryView> {
    const [row] = await this.db.select().from(chatMemories).where(and(eq(chatMemories.id, id), eq(chatMemories.workspaceId, workspaceId))).limit(1);
    if (!row) throw new NotFoundException('Memory not found');
    return toView(row);
  }

  async save(workspaceId: string, input: SaveChatMemoryRequest): Promise<ChatMemoryView> {
    const content = this.validateContent(input.content);
    const category = this.validateCategory(input.category) ?? CHAT_MEMORY_DEFAULT_CATEGORY;
    const existing = await this.db.select({ id: chatMemories.id }).from(chatMemories).where(eq(chatMemories.workspaceId, workspaceId));
    if (existing.length >= CHAT_MEMORY_MAX_COUNT) throw new ConflictException(`Memory limit of ${CHAT_MEMORY_MAX_COUNT} entries reached; delete an obsolete memory before saving a new one.`);
    const row: ChatMemory = {
      id: `mem_${randomUUID()}`,
      workspaceId,
      content,
      category,
      sourceConversationId: typeof input.sourceConversationId === 'string' && input.sourceConversationId ? input.sourceConversationId : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.db.insert(chatMemories).values(row);
    return toView(row);
  }

  async update(workspaceId: string, id: string, input: UpdateChatMemoryRequest): Promise<ChatMemoryView> {
    const content = input.content === undefined ? undefined : this.validateContent(input.content);
    const category = this.validateCategory(input.category);
    if (content === undefined && category === undefined) throw new ConflictException('Provide content, category, or both.');
    const updated = await this.db.update(chatMemories).set({ ...(content === undefined ? {} : { content }), ...(category === undefined ? {} : { category }), updatedAt: new Date() }).where(and(eq(chatMemories.id, id), eq(chatMemories.workspaceId, workspaceId))).returning();
    if (updated.length === 0) throw new NotFoundException('Memory not found');
    return toView(updated[0]);
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const deleted = await this.db.delete(chatMemories).where(and(eq(chatMemories.id, id), eq(chatMemories.workspaceId, workspaceId)));
    if (deleted.changes === 0) throw new NotFoundException('Memory not found');
  }

  private validateContent(content: unknown): string {
    if (typeof content !== 'string' || !content.trim() || content.length > CHAT_MEMORY_CONTENT_MAX_CHARS) throw new ConflictException(`content must be a non-empty string no longer than ${CHAT_MEMORY_CONTENT_MAX_CHARS} characters.`);
    return content.trim();
  }

  private validateCategory(category: unknown): ChatMemoryCategory | undefined {
    if (category === undefined) return undefined;
    if (typeof category !== 'string' || !(CHAT_MEMORY_CATEGORIES as readonly string[]).includes(category)) throw new ConflictException(`category must be one of: ${CHAT_MEMORY_CATEGORIES.join(', ')}.`);
    return category as ChatMemoryCategory;
  }
}
