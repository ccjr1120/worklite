import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { ChatMemoryList, ChatMemoryView, SaveChatMemoryRequest, UpdateChatMemoryRequest } from '@worklite/contracts';
import { chatMemories, type ChatMemory, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

export const CHAT_MEMORY_CONTENT_MAX_CHARS = 2000;
export const CHAT_MEMORY_MAX_COUNT = 100;
export const CHAT_MEMORY_PROMPT_MAX_COUNT = 50;
export const CHAT_MEMORY_PROMPT_MAX_CHARS = 6000;

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

const toView = (row: ChatMemory): ChatMemoryView => ({
  id: row.id,
  content: row.content,
  sourceConversationId: row.sourceConversationId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class ChatMemoriesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(workspaceId: string): Promise<ChatMemoryList> {
    const rows = await this.db.select().from(chatMemories).where(eq(chatMemories.workspaceId, workspaceId)).orderBy(desc(chatMemories.updatedAt));
    return { items: rows.map(toView) };
  }

  async save(workspaceId: string, input: SaveChatMemoryRequest): Promise<ChatMemoryView> {
    const content = this.validateContent(input.content);
    const existing = await this.db.select({ id: chatMemories.id }).from(chatMemories).where(eq(chatMemories.workspaceId, workspaceId));
    if (existing.length >= CHAT_MEMORY_MAX_COUNT) throw new ConflictException(`Memory limit of ${CHAT_MEMORY_MAX_COUNT} entries reached; delete an obsolete memory before saving a new one.`);
    const row: ChatMemory = {
      id: `mem_${randomUUID()}`,
      workspaceId,
      content,
      sourceConversationId: typeof input.sourceConversationId === 'string' && input.sourceConversationId ? input.sourceConversationId : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.db.insert(chatMemories).values(row);
    return toView(row);
  }

  async update(workspaceId: string, id: string, input: UpdateChatMemoryRequest): Promise<ChatMemoryView> {
    const content = this.validateContent(input.content);
    const updated = await this.db.update(chatMemories).set({ content, updatedAt: new Date() }).where(and(eq(chatMemories.id, id), eq(chatMemories.workspaceId, workspaceId))).returning();
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
}
