import { eq } from 'drizzle-orm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { chatConfigurations, createDb, initializeDatabase, skills, type Database } from '@worklite/db';
import { WorkspaceService } from '../teams/teams.service';
import type { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentsService } from './agents.service';

const CHAT_AGENT_ID = 'agt_system_helper_chat';
const WORKSPACE_ID = 'workspace_personal';

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

async function setup() {
  const database = createDb(':memory:');
  db = database;
  await initializeDatabase(database);
  database.insert(skills).values([
    { id: 'sk_valid_one', workspaceId: WORKSPACE_ID, name: 'skill-one', source: 'local', instructions: '# One', validation: 'valid' },
    { id: 'sk_valid_two', workspaceId: WORKSPACE_ID, name: 'skill-two', source: 'local', instructions: '# Two', validation: 'valid' },
  ]).run();
  const workspaces = new WorkspaceService(database);
  const resources = { reconcileWorkspaceSkills: async () => {} } as unknown as WorkspaceResourcesService;
  const service = new AgentsService(database, workspaces, resources);
  return { service };
}

async function currentConfiguration(database: Database) {
  const [configuration] = await database.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, WORKSPACE_ID)).orderBy(chatConfigurations.revision).limit(1);
  return configuration;
}

describe('AgentsService.update — Chat skillIds', () => {
  it('updates skillIds and bumps the configuration revision', async () => {
    const { service } = await setup();
    const request = {} as Request;
    const view = await service.update(request, 'personal', CHAT_AGENT_ID, {
      expectedConfigurationRevision: 1,
      skillIds: ['sk_valid_one', 'sk_valid_two'],
    });
    expect(view.chatConfiguration?.revision).toBe(2);
    expect(view.chatConfiguration?.skillIds).toEqual(['sk_valid_one', 'sk_valid_two']);
  });

  it('rejects a mismatched expectedConfigurationRevision without writing', async () => {
    const { service } = await setup();
    const request = {} as Request;
    await expect(service.update(request, 'personal', CHAT_AGENT_ID, {
      expectedConfigurationRevision: 99,
      skillIds: ['sk_valid_one'],
    })).rejects.toThrow(ConflictException);
    const configuration = await currentConfiguration(db!);
    expect(configuration.revision).toBe(1);
    expect(configuration.skillIds).toEqual([]);
  });

  it('rejects an unknown skill id without a partial write', async () => {
    const { service } = await setup();
    const request = {} as Request;
    await expect(service.update(request, 'personal', CHAT_AGENT_ID, {
      expectedConfigurationRevision: 1,
      skillIds: ['sk_valid_one', 'sk_does_not_exist'],
    })).rejects.toThrow(BadRequestException);
    const configuration = await currentConfiguration(db!);
    expect(configuration.revision).toBe(1);
    expect(configuration.skillIds).toEqual([]);
  });

  it('keeps the current skillIds when the field is omitted', async () => {
    const { service } = await setup();
    const request = {} as Request;
    await service.update(request, 'personal', CHAT_AGENT_ID, {
      expectedConfigurationRevision: 1,
      skillIds: ['sk_valid_one'],
    });
    const view = await service.update(request, 'personal', CHAT_AGENT_ID, {
      expectedConfigurationRevision: 2,
      extensionPrompt: 'updated prompt',
    });
    expect(view.chatConfiguration?.revision).toBe(3);
    expect(view.chatConfiguration?.skillIds).toEqual(['sk_valid_one']);
  });
});
