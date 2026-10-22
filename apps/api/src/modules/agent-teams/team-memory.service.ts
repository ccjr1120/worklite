import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  agentTeamGroupEvents,
  agentTeamMemories,
  agentTeamRepositories,
  type Database,
} from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { rankTeamMemories, memoryTitle } from './team-memory-ranking';

// Who is acting on Team memory. `allowedRepositoryIds` is the Run's captured
// repository scope (canonical Team repository ids); it never comes from model input.
export type TeamMemoryActorContext = {
  workspaceId: string;
  teamId: string;
  groupId?: string | null;
  runId?: string | null;
  taskAttemptId?: string | null;
  role?: string | null;
  sourceMessageId?: string | null;
  allowedRepositoryIds?: readonly string[] | null;
  createdBy: 'chat' | 'role';
};

export type TeamMemoryRow = typeof agentTeamMemories.$inferSelect;

export type TeamMemorySearchResult = {
  id: string;
  repositoryId: string | null;
  repositoryName: string | null;
  title: string;
  excerpt: string;
  score: number;
  updatedAt: string;
};

export type TeamMemoryWriteResult = {
  memory: TeamMemoryRow;
  operation: 'created' | 'updated' | 'unchanged';
};

// Canonical text used for same-scope duplicate detection: whitespace and case are
// ignored, so a role rewriting the same fact updates the existing entry.
export function normalizeMemoryText(content: string): string {
  return content.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

@Injectable()
export class TeamMemoryService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async search(
    context: TeamMemoryActorContext,
    input: { query?: string; repositoryId?: string | null; limit?: number } = {},
  ): Promise<TeamMemorySearchResult[]> {
    await this.assertRepository(context, input.repositoryId);
    const rows = await this.scopedRows(context, input.repositoryId);
    const repositories = await this.repositoryNames(context.teamId);
    const ranked = rankTeamMemories(
      rows.map((row) => ({ ...row, updatedAt: row.updatedAt ?? undefined })),
      { query: input.query, repositories: [...repositories].map(([memoryRepositoryId, name]) => ({ memoryRepositoryId, name })) },
    );
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    return ranked.slice(0, limit).map((row) => ({
      id: row.id,
      repositoryId: row.repositoryId,
      repositoryName: row.repositoryId ? repositories.get(row.repositoryId) ?? null : null,
      title: row.title,
      excerpt: excerpt(row.content),
      score: row.score,
      updatedAt: (row.updatedAt instanceof Date ? row.updatedAt : new Date()).toISOString(),
    }));
  }

  async read(context: TeamMemoryActorContext, memoryId: string): Promise<{
    id: string;
    repositoryId: string | null;
    repositoryName: string | null;
    repositoryDirectory: string | null;
    title: string;
    content: string;
    createdBy: string;
    sourceRole: string | null;
    upsertKey: string | null;
    updatedAt: string;
  }> {
    const row = await this.requireMemory(context, memoryId);
    const repository = row.repositoryId ? await this.repository(row.repositoryId) : undefined;
    return {
      id: row.id,
      repositoryId: row.repositoryId,
      repositoryName: repository?.name ?? null,
      repositoryDirectory: repository?.directory ?? null,
      title: memoryTitle(row.content),
      content: row.content,
      createdBy: row.createdBy,
      sourceRole: row.sourceRole,
      upsertKey: row.upsertKey,
      updatedAt: (row.updatedAt ?? new Date()).toISOString(),
    };
  }

  /**
   * Writes a memory for the acting role. The default scope is the Team; an explicit
   * repositoryId must belong to the Team and to the Run's captured repository scope.
   * A stable upsertKey or a same-scope normalized duplicate updates the existing
   * entry instead of adding a near-copy.
   */
  async write(
    context: TeamMemoryActorContext,
    input: { id?: string; content: string; repositoryId?: string | null; upsertKey?: string | null },
  ): Promise<TeamMemoryWriteResult> {
    const content = this.assertContent(input.content);
    const repositoryId = input.repositoryId ?? null;
    await this.assertRepository(context, repositoryId);
    if (input.id) {
      const [existing] = await this.db.select().from(agentTeamMemories).where(and(
        eq(agentTeamMemories.id, input.id),
        eq(agentTeamMemories.workspaceId, context.workspaceId),
        eq(agentTeamMemories.teamId, context.teamId),
      )).limit(1);
      if (existing) return { memory: existing, operation: 'unchanged' };
    }
    const upsertKey = input.upsertKey?.trim() || null;
    const deduped = await this.findByScope(context, repositoryId, { upsertKey, content });
    if (deduped) {
      const [updated] = await this.db.update(agentTeamMemories).set({
        content,
        upsertKey,
        updatedAt: new Date(),
      }).where(eq(agentTeamMemories.id, deduped.id)).returning();
      const memory = updated ?? deduped;
      await this.appendEvent(context, { memoryId: memory.id, operation: 'updated' });
      return { memory, operation: 'updated' };
    }
    const now = new Date();
    const [inserted] = await this.db.insert(agentTeamMemories).values({
      id: input.id ?? `atmemory_${randomUUID()}`,
      workspaceId: context.workspaceId,
      teamId: context.teamId,
      repositoryId,
      role: null,
      content,
      sourceMessageId: context.sourceMessageId ?? null,
      sourceRunId: context.runId ?? null,
      sourceRole: (context.role ?? null) as TeamMemoryRow['sourceRole'],
      sourceTaskAttemptId: context.taskAttemptId ?? null,
      createdBy: context.createdBy,
      upsertKey,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    if (!inserted) {
      // A concurrent retry inserted the same deterministic id or upsert key first.
      const existing = await this.findByScope(context, repositoryId, { upsertKey, content });
      const [byId] = input.id ? await this.db.select().from(agentTeamMemories).where(and(
        eq(agentTeamMemories.id, input.id),
        eq(agentTeamMemories.workspaceId, context.workspaceId),
        eq(agentTeamMemories.teamId, context.teamId),
      )).limit(1) : [];
      const memory = byId ?? existing;
      if (!memory) throw new BadRequestException('The Team memory could not be saved.');
      return { memory, operation: 'unchanged' };
    }
    await this.appendEvent(context, { memoryId: inserted.id, operation: 'created' });
    return { memory: inserted, operation: 'created' };
  }

  async update(
    context: TeamMemoryActorContext,
    input: { memoryId: string; content?: string; repositoryId?: string | null; upsertKey?: string | null },
  ): Promise<{ memory: TeamMemoryRow; operation: 'updated' }> {
    const existing = await this.requireMemory(context, input.memoryId);
    const repositoryId = input.repositoryId === undefined ? existing.repositoryId : input.repositoryId;
    await this.assertRepository(context, repositoryId);
    const content = input.content === undefined ? existing.content : this.assertContent(input.content);
    const [updated] = await this.db.update(agentTeamMemories).set({
      content,
      repositoryId,
      ...(input.upsertKey === undefined ? {} : { upsertKey: input.upsertKey?.trim() || null }),
      updatedAt: new Date(),
    }).where(eq(agentTeamMemories.id, existing.id)).returning();
    const memory = updated ?? existing;
    await this.appendEvent(context, { memoryId: memory.id, operation: 'updated' });
    return { memory, operation: 'updated' };
  }

  private async scopedRows(context: TeamMemoryActorContext, repositoryId?: string | null): Promise<TeamMemoryRow[]> {
    const scope = [eq(agentTeamMemories.workspaceId, context.workspaceId), eq(agentTeamMemories.teamId, context.teamId)];
    // Legacy role-scoped entries are retained for Chat but never surface to roles.
    const visible = repositoryId === undefined
      ? [isNull(agentTeamMemories.role)]
      : [isNull(agentTeamMemories.role), repositoryId === null ? isNull(agentTeamMemories.repositoryId) : eq(agentTeamMemories.repositoryId, repositoryId)];
    const allowed = context.allowedRepositoryIds;
    const allowedFilter = allowed && repositoryId === undefined
      ? [allowed.length ? or(isNull(agentTeamMemories.repositoryId), inArray(agentTeamMemories.repositoryId, [...allowed]))! : isNull(agentTeamMemories.repositoryId)]
      : [];
    return this.db.select().from(agentTeamMemories)
      .where(and(...scope, ...visible, ...allowedFilter))
      .orderBy(desc(agentTeamMemories.updatedAt))
      .limit(500);
  }

  private async findByScope(
    context: TeamMemoryActorContext,
    repositoryId: string | null,
    options: { upsertKey: string | null; content: string },
  ): Promise<TeamMemoryRow | undefined> {
    const scope = and(
      eq(agentTeamMemories.workspaceId, context.workspaceId),
      eq(agentTeamMemories.teamId, context.teamId),
      repositoryId === null ? isNull(agentTeamMemories.repositoryId) : eq(agentTeamMemories.repositoryId, repositoryId),
    );
    if (options.upsertKey) {
      const [byKey] = await this.db.select().from(agentTeamMemories)
        .where(and(scope, eq(agentTeamMemories.upsertKey, options.upsertKey))).limit(1);
      if (byKey) return byKey;
    }
    const normalized = normalizeMemoryText(options.content);
    const rows = await this.db.select().from(agentTeamMemories).where(scope).orderBy(desc(agentTeamMemories.updatedAt)).limit(200);
    return rows.find((row) => normalizeMemoryText(row.content) === normalized);
  }

  private async requireMemory(context: TeamMemoryActorContext, memoryId: string): Promise<TeamMemoryRow> {
    const [row] = await this.db.select().from(agentTeamMemories).where(and(
      eq(agentTeamMemories.id, memoryId),
      eq(agentTeamMemories.workspaceId, context.workspaceId),
      eq(agentTeamMemories.teamId, context.teamId),
    )).limit(1);
    if (!row) throw new NotFoundException('Agent Team memory not found.');
    if (row.repositoryId && context.allowedRepositoryIds && !context.allowedRepositoryIds.includes(row.repositoryId)) {
      throw new BadRequestException('The Team memory is outside this Run repository scope.');
    }
    return row;
  }

  private async assertRepository(context: TeamMemoryActorContext, repositoryId: string | null | undefined): Promise<void> {
    if (!repositoryId) return;
    if (context.allowedRepositoryIds && !context.allowedRepositoryIds.includes(repositoryId)) {
      throw new BadRequestException('The memory repository is outside this Run repository scope.');
    }
    const [repository] = await this.db.select({ id: agentTeamRepositories.id }).from(agentTeamRepositories).where(and(
      eq(agentTeamRepositories.id, repositoryId),
      eq(agentTeamRepositories.workspaceId, context.workspaceId),
      eq(agentTeamRepositories.teamId, context.teamId),
    )).limit(1);
    if (!repository) throw new BadRequestException('The memory repository is not available for this Agent Team.');
  }

  private async repository(repositoryId: string): Promise<{ name: string; directory: string } | undefined> {
    const [repository] = await this.db.select({ name: agentTeamRepositories.name, directory: agentTeamRepositories.directory })
      .from(agentTeamRepositories).where(eq(agentTeamRepositories.id, repositoryId)).limit(1);
    return repository;
  }

  private async repositoryNames(teamId: string): Promise<Map<string, string>> {
    const rows = await this.db.select({ id: agentTeamRepositories.id, name: agentTeamRepositories.name })
      .from(agentTeamRepositories).where(eq(agentTeamRepositories.teamId, teamId));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private assertContent(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('Memory content is required.');
    const content = value.trim();
    if (content.length > 100_000) throw new BadRequestException('Memory content is too long.');
    return content;
  }

  private async appendEvent(context: TeamMemoryActorContext, payload: Record<string, unknown>): Promise<void> {
    if (!context.groupId) return;
    await this.db.transaction((transaction) => {
      const [latest] = transaction.select({ sequence: agentTeamGroupEvents.sequence }).from(agentTeamGroupEvents)
        .where(eq(agentTeamGroupEvents.groupId, context.groupId!)).orderBy(desc(agentTeamGroupEvents.sequence)).limit(1).all();
      transaction.insert(agentTeamGroupEvents).values({
        groupId: context.groupId!,
        sequence: (latest?.sequence ?? 0) + 1,
        type: 'memory.updated',
        payload,
        createdAt: new Date(),
      }).run();
    });
  }
}

function excerpt(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 500 ? `${compact.slice(0, 499)}…` : compact;
}
