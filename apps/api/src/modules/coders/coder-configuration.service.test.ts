import { afterEach, describe, expect, it } from 'vitest';
import {
  coders,
  createDb,
  initializeDatabase,
  skillFiles,
  skills,
  type Database,
  type StoredAgentTeamRoleConfiguration,
} from '@worklite/db';
import { AgentTeamConfigurationService } from './coder-configuration.service';

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

async function setup() {
  const database = createDb(':memory:');
  db = database;
  await initializeDatabase(database);
  database.insert(coders).values({
    id: 'team_1',
    workspaceId: 'workspace_personal',
    name: 'executor',
    description: '',
    processId: 'bmad-tea',
    processVersion: '1',
    roles: [],
  }).run();
  database.insert(skills).values({
    id: 'sk_dino',
    workspaceId: 'workspace_personal',
    name: 'dino-cli',
    source: 'local',
    validation: 'valid',
    instructions: '# Dino CLI\nUse dino-cli account current.',
  }).run();
  database.insert(skillFiles).values([
    { skillId: 'sk_dino', path: 'SKILL.md', content: '# Dino CLI\nUse dino-cli account current.' },
    { skillId: 'sk_dino', path: 'references/commands.md', content: 'account login -e <email>' },
  ]).run();
  const resources = { publicModelRuntime: async () => ({ protocol: 'anthropic/messages' }), reconcileWorkspaceSkills: async () => undefined };
  return new AgentTeamConfigurationService(database, resources as never);
}

function planner(skillIds: string[]): Omit<StoredAgentTeamRoleConfiguration, 'skills' | 'mcpServers'> & { skillIds: string[]; mcpServerIds: string[] } {
  return {
    role: 'planner',
    publicModelId: '',
    instructions: 'Dispatch the request.',
    entryPoints: [],
    toolNames: ['read'],
    skillIds,
    mcpServerIds: [],
  };
}

describe('AgentTeamConfigurationService Skill capture', () => {
  it('captures the Skill instruction text and package files for a role skillId', async () => {
    const configuration = await setup();

    const updated = await configuration.update('workspace_personal', 'team_1', { roles: [planner(['sk_dino'])] });

    expect(updated.roles[0]?.skills).toEqual([{
      id: 'sk_dino',
      name: 'dino-cli',
      instructions: '# Dino CLI\nUse dino-cli account current.',
      files: [
        { path: 'SKILL.md', content: '# Dino CLI\nUse dino-cli account current.' },
        { path: 'references/commands.md', content: 'account login -e <email>' },
      ],
    }]);
  });

  it('rejects a Skill id that is not in this workspace', async () => {
    const configuration = await setup();

    await expect(configuration.update('workspace_personal', 'team_1', { roles: [planner(['sk_missing'])] }))
      .rejects.toThrow('A selected Skill was not found in this workspace.');
  });

  it('rejects roles retired from the Router configuration', async () => {
    const configuration = await setup();
    for (const role of ['dispatcher', 'executor-manager', 'worktree-manager']) {
      await expect(configuration.update('workspace_personal', 'team_1', { roles: [{ ...planner([]), role }] }))
        .rejects.toThrow('Dispatcher, Executor Manager, and Worktree Manager roles are retired');
    }
  });
});

describe('Coder lifecycle', () => {
  it('persists created configuration, copies a template and soft deletes independently', async () => {
    const configuration = await setup();
    const created = await configuration.create('workspace_personal', { name: 'Research', description: 'Investigate projects' });
    expect(created.roles.map((role) => role.role)).toEqual(['planner', 'implementer', 'router']);
    const changed = await configuration.updateRole('workspace_personal', created.id, 'planner', { instructions: 'Investigate carefully.' });
    await configuration.update('workspace_personal', created.id, { description: 'Updated purpose' });
    const copy = await configuration.create('workspace_personal', { name: 'Research copy', templateCoderId: created.id });
    expect(copy.id).not.toBe(created.id);
    expect(copy.description).toBe('Updated purpose');
    expect(copy.roles[0]?.instructions).toBe('Investigate carefully.');
    expect((await configuration.getTeam('workspace_personal', created.id)).roles).toEqual(changed.roles);
    await configuration.deleteTeam('workspace_personal', created.id, created.id);
    expect((await configuration.getTeam('workspace_personal', created.id)).deletedAt).not.toBeNull();
    expect((await configuration.getTeam('workspace_personal', copy.id)).deletedAt).toBeNull();
    await expect(configuration.create('workspace_personal', { name: 'Research copy' })).rejects.toThrow();
  });

  it('permits deleting the final Coder and creating a new one', async () => {
    const configuration = await setup();
    await configuration.deleteTeam('workspace_personal', 'team_1', 'team_1');
    const replacement = await configuration.create('workspace_personal', { name: 'Replacement' });
    expect(replacement.roles).toHaveLength(3);
  });
});
