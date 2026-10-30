import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  coderMemories,
  coderRepositories,
  coders,
  createDb,
  initializeDatabase,
  workspaces,
  type Database,
} from '@worklite/db';
import { AgentTeamMemoryToolsService } from './coder-memory-tools.service';
import { roleMemoryManagedToolsEnabled } from './coder-runtime.service';
import { TeamMemoryService } from './coder-memory.service';

// The managed memory tools are available to ordinary v11 roles only. Their Coder,
// Run, attempt, role and repository scope come from the runtime closure; tool input
// can choose content, an in-scope repository and an upsert key, nothing else.

let db: Database;
let tools: AgentTeamMemoryToolsService;

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const now = new Date();
  await db.insert(workspaces).values({ id: 'workspace_a', slug: 'a', name: 'A', createdAt: now, updatedAt: now });
  await db.insert(coders).values([
    { id: 'team_a', workspaceId: 'workspace_a', name: 'Executor A', description: '', processId: 'bmad-tea', processVersion: '1', createdAt: now, updatedAt: now },
    { id: 'team_b', workspaceId: 'workspace_a', name: 'Executor B', description: '', processId: 'bmad-tea', processVersion: '1', createdAt: now, updatedAt: now },
  ]);
  await db.insert(coderRepositories).values({
    id: 'repo_a1', workspaceId: 'workspace_a', coderId: 'team_a', name: 'api', directory: '/projects/api', createdAt: now, updatedAt: now,
  });
  tools = new AgentTeamMemoryToolsService(new TeamMemoryService(db));
});

afterEach(() => {
  db.$client.close();
});

const context = {
  workspaceId: 'workspace_a',
  coderId: 'team_a',
  runId: 'atrun_a',
  taskAttemptId: 'attempt_a',
  role: 'developer',
  allowedRepositoryIds: ['repo_a1'],
};

describe('roleMemoryManagedToolsEnabled', () => {
  it('enables the tools for ordinary roles from orchestration v11', () => {
    expect(roleMemoryManagedToolsEnabled(11, 'developer')).toBe(true);
    expect(roleMemoryManagedToolsEnabled(11, 'planner')).toBe(true);
  });

  it('keeps v10 and earlier roles without Coder memory tools', () => {
    expect(roleMemoryManagedToolsEnabled(10, 'developer')).toBe(false);
    expect(roleMemoryManagedToolsEnabled(9, 'developer')).toBe(false);
    expect(roleMemoryManagedToolsEnabled(undefined, 'developer')).toBe(false);
  });

  it('does not give the Executor Manager the role memory tool surface', () => {
    expect(roleMemoryManagedToolsEnabled(11, 'executor-manager')).toBe(false);
  });
});

describe('AgentTeamMemoryToolsService', () => {
  it('exposes exactly the four role memory tools', () => {
    expect(tools.toolDefinitions().map((definition) => definition.name)).toEqual([
      'coder_memory_search',
      'coder_memory_read',
      'coder_memory_write',
      'coder_memory_update',
    ]);
  });

  it('writes with the closure Coder even when tool input names another Coder', async () => {
    const response = await tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_write', input: { content: 'Bound fact.', coderId: 'team_b', workspaceId: 'other' } },
    });
    const parsed = JSON.parse(response) as { id: string; operation: string };

    expect(parsed.operation).toBe('created');
    const [row] = await db.select().from(coderMemories);
    expect(row).toMatchObject({ id: parsed.id, coderId: 'team_a', workspaceId: 'workspace_a', createdBy: 'role', sourceRole: 'developer' });
  });

  it('is idempotent per Run, task and tool call', async () => {
    const call = { toolName: 'coder_memory_write', input: { content: 'Retried fact.' } };
    const first = JSON.parse(await tools.execute({ context, taskKey: 'group_1_developer', call })) as { id: string; operation: string };
    const second = JSON.parse(await tools.execute({ context, taskKey: 'group_1_developer', call })) as { id: string; operation: string };

    expect(second.id).toBe(first.id);
    expect(second.operation).toBe('unchanged');
    expect(await db.select().from(coderMemories)).toHaveLength(1);
  });

  it('rejects a repository outside the captured Run scope', async () => {
    await expect(tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_write', input: { content: 'Wrong repo.', repositoryId: 'repo_missing' } },
    })).rejects.toMatchObject({ status: 400 });
  });

  it('accepts the group repository id shown in the task context for an in-scope repository', async () => {
    const written = JSON.parse(await tools.execute({
      context: { ...context, repositoryIdAliases: { group_repo_a1: 'repo_a1' } },
      taskKey: 'group_0_planner',
      call: { toolName: 'coder_memory_write', input: { content: 'Group repo fact.', repositoryId: 'group_repo_a1' } },
    })) as { repositoryId: string | null };
    expect(written.repositoryId).toBe('repo_a1');
  });

  it('reads back a memory through search and read', async () => {
    const written = JSON.parse(await tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_write', input: { content: 'Searchable Coder decision.', repositoryId: 'repo_a1' } },
    })) as { id: string };

    const results = JSON.parse(await tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_search', input: { query: 'searchable' } },
    })) as Array<{ id: string; repositoryName: string | null }>;
    expect(results).toMatchObject([{ id: written.id, repositoryName: 'api' }]);

    const read = JSON.parse(await tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_read', input: { memoryId: written.id } },
    })) as { content: string };
    expect(read.content).toBe('Searchable Coder decision.');
  });

  it('updates an existing memory by id', async () => {
    const written = JSON.parse(await tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_write', input: { content: 'Initial text.' } },
    })) as { id: string };

    const updated = JSON.parse(await tools.execute({
      context,
      taskKey: 'group_0_developer',
      call: { toolName: 'coder_memory_update', input: { memoryId: written.id, content: 'Corrected text.' } },
    })) as { id: string; content: string; operation: string };
    expect(updated).toMatchObject({ id: written.id, content: 'Corrected text.', operation: 'updated' });
  });
});
