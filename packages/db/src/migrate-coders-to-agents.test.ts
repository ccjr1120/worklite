import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, type Database } from './client';
import { agents, coders, coderGroups, coderTaskAttempts, coderDocuments, coderOperations, type StoredAgentTeamRoleConfiguration } from './schema';
import { migrateCodersToAgents } from './migrate-coders-to-agents';

let db: Database;
afterEach(() => db?.$client.close());
const workspaceId = 'workspace_personal';
const role = (role: string, executor?: 'codex' | 'claude'): StoredAgentTeamRoleConfiguration => ({ role, publicModelId: 'provider/model', instructions: `Instructions for ${role}`, entryPoints: [], skills: [], mcpServers: [], toolNames: ['read', 'glob', 'process_reference'], ...(executor ? { executor } : {}) });
async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  db.insert(coders).values({ id: 'team', workspaceId, name: 'Development', description: 'Build products', processId: 'bmad-tea', processVersion: '1', roles: [role('router'), role('planner'), role('developer', 'codex')], workingPractice: 'Review actual changes', projectGitPolicy: 'Use a feature branch' }).run();
}
describe('Coding Team replacement migration', () => {
  it('converts role configurations into native and engine-backed Agents, with a dynamic lead', async () => {
    await setup();
    db.insert(coderGroups).values({ id: 'group', workspaceId, coderId: 'team', title: 'Old task' }).run();
    db.$client.prepare("INSERT INTO coder_versions (id,workspace_id,coder_id,version,snapshot) VALUES ('version',?,'team',1,'{}')").run(workspaceId);
    db.$client.prepare("INSERT INTO coder_runs (id,workspace_id,coder_id,coder_version_id,intent,status,project_directory,lang_graph_thread_id) VALUES ('run',?,'team','version','old goal','succeeded','/tmp','thread')").run(workspaceId);
    db.insert(coderTaskAttempts).values({ id: 'attempt', workspaceId, runId: 'run', taskKey: 'task', attemptIndex: 1, role: 'developer', inputRevision: {}, inputFingerprint: 'input' }).run();
    db.insert(coderDocuments).values({ id: 'doc', workspaceId, runId: 'run', taskAttemptId: 'attempt', key: 'plan', revision: 1, title: 'Plan', content: 'Old content' }).run();
    db.insert(coderOperations).values({ key: 'operation', workspaceId, runId: 'run', taskAttemptId: 'attempt', taskKey: 'task', operationKey: 'read', toolName: 'read', inputFingerprint: 'input' }).run();
    migrateCodersToAgents(db.$client);
    const all = db.select().from(agents).all().filter((agent) => agent.kind === 'custom');
    expect(all).toHaveLength(3);
    const lead = all.find((agent) => agent.name === 'Development')!;
    expect(lead.collaboration?.subAgentIds).toHaveLength(2);
    expect(lead.systemPrompt).toContain('Review actual changes');
    expect(lead.systemPrompt).toContain('Use a feature branch');
    expect(all.find((agent) => agent.name === 'developer')?.runtime).toEqual({ kind: 'codex', projectDirectory: '' });
    expect(all.find((agent) => agent.name === 'planner')?.collaboration?.builtinToolNames).toEqual(['read', 'glob']);
    for (const table of ['coders', 'coder_groups', 'coder_versions', 'coder_runs', 'coder_task_attempts', 'coder_documents', 'coder_operations']) expect(db.$client.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    migrateCodersToAgents(db.$client);
    expect(db.select().from(agents).all().filter((agent) => agent.kind === 'custom')).toHaveLength(3);
  });
  it('preserves source configuration and rolls back created Agents if a saved role list is invalid', async () => {
    await setup();
    db.$client.prepare("INSERT INTO coders (id,workspace_id,name,description,process_id,process_version,roles) VALUES ('broken',?,'Broken','broken','old','1','invalid')").run(workspaceId);
    expect(() => migrateCodersToAgents(db.$client)).toThrow();
    expect(db.select().from(agents).all().filter((agent) => agent.kind === 'custom')).toHaveLength(0);
    expect(db.$client.prepare('SELECT id FROM coders').all()).toHaveLength(2);
  });
});
