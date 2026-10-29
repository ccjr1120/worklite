import { afterEach, describe, expect, it } from 'vitest';
import {
  executorCategories,
  createDb,
  initializeDatabase,
  skillFiles,
  skills,
  type Database,
  type StoredAgentTeamRoleConfiguration,
} from '@worklite/db';
import { AgentTeamConfigurationService } from './agent-team-configuration.service';

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

async function setup() {
  const database = createDb(':memory:');
  db = database;
  await initializeDatabase(database);
  database.insert(executorCategories).values({
    id: 'team_1',
    workspaceId: 'workspace_personal',
    name: 'Team',
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
    instructions: '# Dino CLI\nUse dino-cli account current.',
  }).run();
  database.insert(skillFiles).values([
    { skillId: 'sk_dino', path: 'SKILL.md', content: '# Dino CLI\nUse dino-cli account current.' },
    { skillId: 'sk_dino', path: 'references/commands.md', content: 'account login -e <email>' },
  ]).run();
  const resources = { publicModelRuntime: async () => ({ protocol: 'anthropic/messages' }) };
  return new AgentTeamConfigurationService(database, resources as never);
}

function dispatcher(skillIds: string[]): Omit<StoredAgentTeamRoleConfiguration, 'skills' | 'mcpServers'> & { skillIds: string[]; mcpServerIds: string[] } {
  return {
    role: 'dispatcher',
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

    const updated = await configuration.update('workspace_personal', 'team_1', { roles: [dispatcher(['sk_dino'])] });

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

    await expect(configuration.update('workspace_personal', 'team_1', { roles: [dispatcher(['sk_missing'])] }))
      .rejects.toThrow('A selected Skill was not found in this workspace.');
  });
});
