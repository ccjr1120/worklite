import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, type Database } from './client';
import { agents, agentSkills, artifacts, skills, workflowDrafts, workflowNodeRuns, workflowRunEvents, workflowRuns, workflowSchedules, workflowVersions, workflows } from './schema';
import { migrateWorkflowsToAgents } from './migrate-workflows-to-agents';

let db: Database;
afterEach(() => db?.$client.close());
const workspaceId = 'workspace_personal';
async function fixture() {
  db = createDb(':memory:'); await initializeDatabase(db);
  db.insert(skills).values({ id: 'research', workspaceId, name: 'research', source: 'local', validation: 'valid', instructions: 'Research' }).run();
  const node = { id: 'writer', type: 'worklite/agent', typeVersion: '1', position: { x: 1, y: 2 }, errorPolicy: 'stop' as const, config: { label: 'Writer', description: 'Write articles', model: ['provider/first', 'provider/fallback'], systemPrompt: 'Write', skillIds: ['research'], mcpServerIds: [], requiredSkillIds: ['research'], outputFormat: 'json', outputContract: ['article'], maxToolRounds: 7 } };
  const definition = { schemaVersion: 1, nodes: [node, { ...node, id: 'map', type: 'worklite/map', config: { subgraph: { nodes: [{ ...node, id: 'nested' }, { ...node, id: 'image', type: 'worklite/image', config: { model: 'codex/gpt-image-2' } }] } } }], edges: [{ id: 'edge', sourceNodeId: 'writer', targetNodeId: 'map', sourcePort: 'output', targetPort: 'context' }], defaults: { errorPolicy: 'stop' as const }, input: { example: 'Write an article' } };
  db.insert(workflows).values({ id: 'workflow', workspaceId, name: 'Articles' }).run();
  db.insert(workflowDrafts).values({ id: 'draft', workspaceId, workflowId: 'workflow', definition }).run();
  db.insert(workflowVersions).values({ id: 'version', workspaceId, workflowId: 'workflow', published: true, definition }).run();
  db.insert(workflowSchedules).values({ id: 'schedule', workspaceId, workflowId: 'workflow', workflowVersionId: 'version', intervalSeconds: 600, enabled: false }).run();
  db.insert(workflowRuns).values({ id: 'run', workspaceId, workflowId: 'workflow', workflowVersionId: 'version', input: 'old', status: 'succeeded' }).run();
  db.insert(workflowNodeRuns).values({ id: 'node-run', runId: 'run', workspaceId, nodeId: 'writer', type: 'worklite/agent', typeVersion: '1', position: 0, status: 'succeeded' }).run();
  db.insert(workflowRunEvents).values({ runId: 'run', sequence: 1, type: 'run.status', payload: {} }).run();
  db.insert(artifacts).values({ id: 'old-artifact', workspaceId, workflowId: 'workflow', runId: 'run', name: 'old article', format: 'text', content: 'old' }).run();
  db.insert(artifacts).values({ id: 'unrelated', workspaceId, name: 'unrelated', format: 'text', content: 'keep' }).run();
}

describe('workflow replacement migration', () => {
  it('migrates nested specialists, capabilities, models, Skills and disabled schedules without retaining graphs or history', async () => {
    await fixture(); migrateWorkflowsToAgents(db.$client);
    const migrated = db.select().from(agents).all().filter((agent) => agent.kind === 'custom');
    const lead = migrated.find((agent) => agent.name === 'Articles')!;
    expect(migrated).toHaveLength(3);
    expect(lead.collaboration?.subAgentIds).toHaveLength(2);
    expect(lead.collaboration?.capabilities).toEqual([expect.objectContaining({ id: 'map/image', type: 'worklite/image', config: { model: 'codex/gpt-image-2' } })]);
    expect(lead.systemPrompt).toContain('Write an article');
    expect(JSON.stringify(lead.collaboration)).not.toContain('edges');
    const writer = migrated.find((agent) => agent.id === lead.collaboration!.subAgentIds[0])!;
    expect(writer.collaboration).toMatchObject({ publicModels: ['provider/first', 'provider/fallback'], outputContract: ['article'], requiredSkillIds: ['research'], limits: { maxToolRounds: 7 } });
    expect(db.select().from(agentSkills).all().filter((assignment) => assignment.agentId === writer.id)).toHaveLength(1);
    expect(db.$client.prepare('SELECT agent_id, enabled, interval_seconds FROM scheduled_agent_tasks').all()).toEqual([{ agent_id: lead.id, enabled: 0, interval_seconds: 600 }]);
    for (const table of ['workflows', 'workflow_drafts', 'workflow_versions', 'workflow_schedules', 'workflow_runs', 'workflow_node_runs', 'workflow_run_events']) expect(db.$client.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(db.select().from(artifacts).all().map((artifact) => artifact.id)).toEqual(['unrelated']);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    migrateWorkflowsToAgents(db.$client);
    expect(db.select().from(agents).all().filter((agent) => agent.kind === 'custom')).toHaveLength(3);
  });

  it('rolls back all changes and preserves source data when any saved definition is invalid', async () => {
    await fixture();
    db.insert(workflows).values({ id: 'broken', workspaceId, name: 'Broken' }).run();
    db.$client.prepare("INSERT INTO workflow_drafts (id, workspace_id, workflow_id, definition) VALUES ('broken-draft', ?, 'broken', 'invalid')").run(workspaceId);
    expect(() => migrateWorkflowsToAgents(db.$client)).toThrow();
    expect(db.select().from(agents).all().filter((agent) => agent.kind === 'custom')).toHaveLength(0);
    expect(db.select().from(workflows).all()).toHaveLength(2);
    expect(db.select().from(workflowRuns).all()).toHaveLength(1);
    expect(db.select().from(artifacts).all()).toHaveLength(2);
  });
});
