import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executorCategoryMemories,
  executorCategoryRepositories,
  executorCategories,
  createDb,
  initializeDatabase,
  workspaces,
  type Database,
} from '@worklite/db';
import { TeamMemoryService, type TeamMemoryActorContext } from './team-memory.service';

// Roles write into one Team's memory and must never see another Team's rows, even
// with the same workspace. Every scope value is server-owned except content,
// repositoryId and upsertKey.

let db: Database;
let service: TeamMemoryService;

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const now = new Date();
  await db.insert(workspaces).values([
    { id: 'workspace_a', slug: 'a', name: 'A', createdAt: now, updatedAt: now },
    { id: 'workspace_b', slug: 'b', name: 'B', createdAt: now, updatedAt: now },
  ]);
  await db.insert(executorCategories).values([
    { id: 'team_a', workspaceId: 'workspace_a', name: 'Team A', description: '', processId: 'bmad-tea', processVersion: '1', createdAt: now, updatedAt: now },
    { id: 'team_b', workspaceId: 'workspace_a', name: 'Team B', description: '', processId: 'bmad-tea', processVersion: '1', createdAt: now, updatedAt: now },
    { id: 'team_c', workspaceId: 'workspace_b', name: 'Team C', description: '', processId: 'bmad-tea', processVersion: '1', createdAt: now, updatedAt: now },
  ]);
  await db.insert(executorCategoryRepositories).values([
    { id: 'repo_a1', workspaceId: 'workspace_a', executorCategoryId: 'team_a', name: 'api', directory: '/projects/api', createdAt: now, updatedAt: now },
    { id: 'repo_a2', workspaceId: 'workspace_a', executorCategoryId: 'team_a', name: 'web', directory: '/projects/web', createdAt: now, updatedAt: now },
    { id: 'repo_b1', workspaceId: 'workspace_a', executorCategoryId: 'team_b', name: 'other', directory: '/projects/other', createdAt: now, updatedAt: now },
    { id: 'repo_c1', workspaceId: 'workspace_b', executorCategoryId: 'team_c', name: 'outside', directory: '/projects/outside', createdAt: now, updatedAt: now },
  ]);
  service = new TeamMemoryService(db);
});

afterEach(() => {
  db.$client.close();
});

function actor(overrides: Partial<TeamMemoryActorContext> = {}): TeamMemoryActorContext {
  return {
    workspaceId: 'workspace_a',
    executorCategoryId: 'team_a',
    runId: 'atrun_a',
    taskAttemptId: 'attempt_a',
    role: 'developer',
    allowedRepositoryIds: ['repo_a1', 'repo_a2'],
    createdBy: 'role',
    ...overrides,
  };
}

describe('TeamMemoryService scope isolation', () => {
  it('keeps two Teams in one workspace apart', async () => {
    const written = await service.write(actor(), { content: 'Team A uses pnpm.' });
    await service.write(actor({ executorCategoryId: 'team_b', runId: 'atrun_b' }), { content: 'Team B uses npm.' });

    const results = await service.search(actor(), { query: 'uses' });
    expect(results.map((result) => result.id)).toEqual([written.memory.id]);

    await expect(service.read(actor({ executorCategoryId: 'team_b' }), written.memory.id))
      .rejects.toMatchObject({ status: 404 });
  });

  it('keeps two Runs of the same Team in the same shared executor category memory', async () => {
    const first = await service.write(actor({ runId: 'atrun_a' }), { content: 'Shared Team fact.' });
    const second = await service.write(actor({ runId: 'atrun_other' }), { content: 'Another Run fact.' });

    const results = await service.search(actor({ runId: 'atrun_other' }), { query: 'fact' });
    expect(results.map((result) => result.id).sort()).toEqual([first.memory.id, second.memory.id].sort());
  });

  it('rejects a repository from another Team or outside the Run scope', async () => {
    await expect(service.write(actor(), { content: 'Wrong repo.', repositoryId: 'repo_b1' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.write(actor(), { content: 'Wrong run scope.', repositoryId: 'repo_a2' }))
      .resolves.toMatchObject({ operation: 'created' });
    await expect(service.write(actor({ allowedRepositoryIds: ['repo_a1'] }), { content: 'Out of scope.', repositoryId: 'repo_a2' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('does not read another Team’s repository memory by id', async () => {
    const teamB = await service.write(
      actor({ executorCategoryId: 'team_b', runId: 'atrun_b', allowedRepositoryIds: ['repo_b1'] }),
      { content: 'Team B repo fact.', repositoryId: 'repo_b1' },
    );
    await expect(service.read(actor(), teamB.memory.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('TeamMemoryService write semantics', () => {
  it('is idempotent for the same deterministic id', async () => {
    const first = await service.write(actor(), { id: 'atmemory_fixed', content: 'Idempotent fact.' });
    const second = await service.write(actor(), { id: 'atmemory_fixed', content: 'Idempotent fact.' });

    expect(first.operation).toBe('created');
    expect(second.memory.id).toBe('atmemory_fixed');
    const rows = await db.select().from(executorCategoryMemories);
    expect(rows).toHaveLength(1);
  });

  it('updates instead of duplicating normalized text in the same scope', async () => {
    const first = await service.write(actor(), { content: 'Use   PNPM for installs.' });
    const second = await service.write(actor(), { content: 'use pnpm for installs.' });

    expect(second.operation).toBe('updated');
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.content).toBe('use pnpm for installs.');
    expect(await db.select().from(executorCategoryMemories)).toHaveLength(1);
  });

  it('updates the same scope by upsertKey but keeps Team and repository scopes separate', async () => {
    const teamLevel = await service.write(actor(), { content: 'Team-level standard.', upsertKey: 'standard' });
    const repoLevel = await service.write(actor(), { content: 'Repository standard.', repositoryId: 'repo_a1', upsertKey: 'standard' });
    const corrected = await service.write(actor(), { content: 'Corrected repository standard.', repositoryId: 'repo_a1', upsertKey: 'standard' });

    expect(repoLevel.memory.id).not.toBe(teamLevel.memory.id);
    expect(corrected.operation).toBe('updated');
    expect(corrected.memory.id).toBe(repoLevel.memory.id);
    expect(await db.select().from(executorCategoryMemories)).toHaveLength(2);
  });

  it('hides legacy role-scoped entries from the role tool surface', async () => {
    await db.insert(executorCategoryMemories).values({
      id: 'legacy_role_memory',
      workspaceId: 'workspace_a',
      executorCategoryId: 'team_a',
      role: 'developer',
      content: 'Legacy role memory.',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await service.search(actor(), { query: 'legacy' })).toEqual([]);
  });

  it('records role provenance on a written memory', async () => {
    const written = await service.write(actor(), { content: 'Provenance fact.' });
    expect(written.memory).toMatchObject({
      createdBy: 'role',
      sourceRole: 'developer',
      sourceRunId: 'atrun_a',
      sourceTaskAttemptId: 'attempt_a',
      role: null,
    });
  });
});
