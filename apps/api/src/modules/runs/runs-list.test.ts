import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, workflowRuns, workflowVersions, workflows, type Database } from '@worklite/db';
import type { RunView } from '@worklite/contracts';
import type { WorkspaceService } from '../teams/teams.service';
import type { AgentExecutionsService } from '../agents/agent-executions.service';
import type { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import type { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import type { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { RunsService } from './runs.service';

const WORKSPACE_ID = 'workspace_personal';
const request = {} as Request;
let db: Database;
let service: RunsService;

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  service = new RunsService(db, workspaces, {} as AgentExecutionsService, { subscribe: () => () => undefined } as unknown as WechatOfficialAccountService, {} as PortkeyGatewayService, {} as ArtifactStorageService);
});

afterEach(() => db.$client.close());

const artifactDefinition = { nodes: [{ id: 'n1', type: 'worklite/artifact' }], edges: [] };
const plainDefinition = { nodes: [{ id: 'n1', type: 'worklite/agent' }], edges: [] };

function seedWorkflow(id: string, versions: Array<{ version: number; published: boolean; definition?: unknown }>) {
  db.insert(workflows).values({ id, workspaceId: WORKSPACE_ID, name: `Workflow ${id}` }).run();
  for (const version of versions) {
    db.insert(workflowVersions).values({ id: `${id}_v${version.version}`, workspaceId: WORKSPACE_ID, workflowId: id, version: version.version, published: version.published, definition: (version.definition ?? plainDefinition) as never }).run();
  }
}

function seedRun(id: string, workflowId: string, version: number, status: RunView['status'], createdAt: number, values: Partial<typeof workflowRuns.$inferInsert> = {}) {
  db.insert(workflowRuns).values({ id, workspaceId: WORKSPACE_ID, workflowId, workflowVersionId: `${workflowId}_v${version}`, status, input: { q: id }, result: { ok: id }, createdAt: new Date(createdAt), updatedAt: new Date(createdAt), finishedAt: status === 'succeeded' ? new Date(createdAt + 5000) : null, ...values }).run();
}

/** The Home page's former selection over the full Run list. */
function previousBoardRun(runs: RunView[], workflowId: string, latestVersion: number): RunView | undefined {
  return runs.find((item) => item.workflowId === workflowId && item.version === `v${latestVersion}` && item.status === 'succeeded');
}

describe('RunsService run lists', () => {
  it('keeps the list fields of the full projection', async () => {
    seedWorkflow('wf_a', [{ version: 1, published: true, definition: artifactDefinition }]);
    seedWorkflow('wf_b', [{ version: 1, published: true }]);
    seedRun('run_a', 'wf_a', 1, 'cancelled', 1_000, { executionState: { active: null } as never, currentNodeId: 'n1' });
    seedRun('run_b', 'wf_b', 1, 'cancelled', 2_000);
    seedRun('run_c', 'wf_b', 1, 'paused', 3_000);
    const runs = await service.list(request, 'personal');
    expect(runs.map((run) => run.id)).toEqual(['run_c', 'run_b', 'run_a']);
    const runA = runs.find((run) => run.id === 'run_a')!;
    expect(runA).toMatchObject({ workflowId: 'wf_a', workflowName: 'Workflow wf_a', version: 'v1', status: 'cancelled', currentStep: 'n1', hasArtifactNode: true, resumable: true, input: { q: 'run_a' }, result: { ok: 'run_a' }, initiator: 'You', workspaceSlug: 'personal' });
    expect(runA.nodeRuns).toBeUndefined();
    expect(runs.find((run) => run.id === 'run_b')).toMatchObject({ hasArtifactNode: false, resumable: false });
    expect(runs.find((run) => run.id === 'run_c')).toMatchObject({ resumable: true });
  });

  it('returns the same board Run per Workflow as the full-list selection', async () => {
    seedWorkflow('wf_a', [{ version: 1, published: true }, { version: 2, published: true }, { version: 3, published: false }]);
    seedWorkflow('wf_b', [{ version: 1, published: true }]);
    seedWorkflow('wf_c', [{ version: 1, published: true }, { version: 2, published: true }]);
    seedRun('a_old_v2', 'wf_a', 2, 'succeeded', 1_000);
    seedRun('a_new_v2', 'wf_a', 2, 'succeeded', 2_000);
    seedRun('a_failed_v2', 'wf_a', 2, 'failed', 3_000);
    seedRun('a_v1', 'wf_a', 1, 'succeeded', 4_000);
    seedRun('a_draft_v3', 'wf_a', 3, 'succeeded', 5_000);
    seedRun('b_v1', 'wf_b', 1, 'succeeded', 1_500);
    // wf_c has only a succeeded Run on an older version, so it has no board Run.
    seedRun('c_v1', 'wf_c', 1, 'succeeded', 1_200);
    const all = await service.list(request, 'personal');
    const latest = await service.latestSucceededPerWorkflow(request, 'personal');
    const expected = [previousBoardRun(all, 'wf_a', 2), previousBoardRun(all, 'wf_b', 1), previousBoardRun(all, 'wf_c', 2)].filter(Boolean);
    expect(latest.map((run) => run.id).sort()).toEqual(expected.map((run) => run!.id).sort());
    expect(latest.map((run) => run.id).sort()).toEqual(['a_new_v2', 'b_v1']);
    expect(latest.find((run) => run.id === 'a_new_v2')).toEqual(all.find((run) => run.id === 'a_new_v2'));
  });

  it('pages one Workflow\'s Runs with a cursor, including equal timestamps', async () => {
    seedWorkflow('wf_a', [{ version: 1, published: true }]);
    seedWorkflow('wf_b', [{ version: 1, published: true }]);
    for (let index = 0; index < 7; index += 1) seedRun(`run_a_${index}`, 'wf_a', 1, 'succeeded', index < 3 ? 5_000 : 1_000 + index);
    seedRun('run_b_0', 'wf_b', 1, 'succeeded', 9_000);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listPage(request, 'personal', { workflowId: 'wf_a', limit: 2, cursor });
      seen.push(...page.items.map((run) => run.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const expected = (await service.list(request, 'personal', { workflowId: 'wf_a' })).map((run) => run.id);
    expect(new Set(seen)).toEqual(new Set(expected));
    expect(seen).toHaveLength(7);
    expect(seen).not.toContain('run_b_0');
  });

  it('rejects a malformed cursor', async () => {
    await expect(service.listPage(request, 'personal', { cursor: 'not-a-cursor' })).rejects.toThrow('Invalid run cursor.');
  });
});
