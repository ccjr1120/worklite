import { eq } from 'drizzle-orm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
});

async function setup() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
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

describe('AgentsService — user-managed lifecycle', () => {
  it('starts without task Agents and persists creation, edits and deletion across initialization', async () => {
    const { service } = await setup();
    const request = {} as Request;
    const customAgents = async () => (await service.list(request, 'personal')).filter((agent) => agent.kind === 'custom');
    expect(await service.list(request, 'personal')).toEqual([]);

    const created = await service.create(request, 'personal', {
      name: '我的研究助手', responsibility: '研究指定主题', systemPrompt: '根据证据回答。',
      providerId: null, model: '', skillIds: ['sk_valid_one'], mcpServerIds: [],
    });
    expect(created.id).toMatch(/^agt_/);
    expect(created.collaboration).toBeNull();
    await service.update(request, 'personal', created.id, { name: '资料助手', systemPrompt: '列出来源。' });
    await initializeDatabase(db!);
    expect(await service.get(request, 'personal', created.id)).toMatchObject({
      name: '资料助手', systemPrompt: '列出来源。', skills: [{ id: 'sk_valid_one' }],
    });

    await service.delete(request, 'personal', created.id);
    await initializeDatabase(db!);
    expect(await customAgents()).toEqual([]);
    await expect(service.get(request, 'personal', created.id)).rejects.toThrow('Agent not found');
  });

  it('creates and updates a standalone Agent with a saved provider and model', async () => {
    const { service } = await setup();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/providers') ? [{ id: 'provider-test', name: 'Test' }] : { name: 'Test', models: ['model-one', 'model-two'] },
    ), { status: 200 })));
    const request = {} as Request;
    const created = await service.create(request, 'personal', {
      name: '研究助手', responsibility: '研究', systemPrompt: '回答问题',
      providerId: 'provider-test', model: 'model-one', skillIds: [], mcpServerIds: [],
    });
    expect(created).toMatchObject({ providerId: 'provider-test', model: 'model-one' });
    const updated = await service.update(request, 'personal', created.id, { model: 'model-two' });
    expect(updated).toMatchObject({ providerId: 'provider-test', model: 'model-two' });
    await expect(service.update(request, 'personal', created.id, { model: 'missing' })).rejects.toThrow(BadRequestException);
    expect((await service.get(request, 'personal', created.id)).model).toBe('model-two');
  });
});
