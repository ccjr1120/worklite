import { eq } from 'drizzle-orm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, artifacts, homeBoardAssignments, homeBoardCategories, workflowDrafts, workflowEditRevisions, workflowRuns, workflowSchedules, workflowVersions, workflows, type Database, type StoredWorkflowDefinition } from '@worklite/db';
import type { WorkflowDetailView } from '@worklite/contracts';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import type { McpClientService } from '../mcp-servers/mcp-client.service';
import { WorkflowSchedulesService } from './workflow-schedules.service';
import { WorkflowsService } from './workflows.service';
import { HomeBoardCategoriesService } from '../home/home-board-categories.service';

let db: Database | undefined;

const request = {} as Request;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

function agentNode(id: string, model: string, systemPrompt: string): StoredWorkflowDefinition['nodes'][number] {
  return {
    id,
    position: { x: 0, y: 0 },
    type: 'worklite/agent',
    typeVersion: '1',
    config: {
      model,
      systemPrompt,
      skillIds: [],
      mcpServerIds: [],
      outputFormat: 'text',
      maxToolCalls: 3,
    },
    errorPolicy: 'stop',
  };
}

function definition(): StoredWorkflowDefinition {
  return {
    schemaVersion: 4,
    input: {},
    defaults: { errorPolicy: 'stop' },
    nodes: [
      { id: 'input', position: { x: -240, y: 0 }, type: 'worklite/input', typeVersion: '1', config: {}, errorPolicy: 'stop' },
      agentNode('agent-1', 'GLM/glm-5.3', 'first prompt'),
      agentNode('agent-2', 'GLM/glm-5.3', 'second prompt'),
      agentNode('agent-3', 'Other/model', 'other prompt'),
    ],
    edges: [],
  };
}

async function setup(assertPublicAgentModel = vi.fn<(model: string) => Promise<void>>().mockResolvedValue(undefined)) {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  const resources = { assertPublicAgentModel } as unknown as WorkspaceResourcesService;
  const workflows = new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
  const created = await workflows.create(request, 'personal', { name: 'Model repair', definition: definition() });
  return { workflows, created, assertPublicAgentModel, workspaces };
}

function node(view: WorkflowDetailView, id: string) {
  const found = view.draft.definition.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe('WorkflowsService draft Agent model replacement', () => {
  it('replaces every matching Agent model, preserves other config, and leaves published versions unchanged', async () => {
    const { workflows, created, assertPublicAgentModel } = await setup();
    const publishedDefinition = definition();
    db!.insert(workflowVersions).values({
      id: 'wfv_existing',
      workspaceId: 'workspace_personal',
      workflowId: created.id,
      version: 1,
      published: true,
      schemaVersion: 4,
      nodes: publishedDefinition.nodes,
      definition: publishedDefinition,
      sourceRevisionId: created.draft.revisionId,
      publishedAt: new Date(),
      publishedBy: 'You',
    }).run();

    const result = await workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/gpt-5',
      source: 'assistant',
      sourceInstruction: 'Repair the retired GLM model reference.',
    });

    expect(assertPublicAgentModel).toHaveBeenCalledWith('OpenAI/gpt-5');
    expect(result.draft.revisionId).not.toBe(created.draft.revisionId);
    expect(node(result, 'agent-1').config).toEqual({ ...(node(created, 'agent-1').config as Record<string, unknown>), model: 'OpenAI/gpt-5' });
    expect(node(result, 'agent-2').config).toEqual({ ...(node(created, 'agent-2').config as Record<string, unknown>), model: 'OpenAI/gpt-5' });
    expect(node(result, 'agent-3').config).toEqual(node(created, 'agent-3').config);
    expect(node(result, 'input').config).toEqual({});

    const [revision] = await db!.select().from(workflowEditRevisions).where(eq(workflowEditRevisions.id, result.draft.revisionId)).limit(1);
    expect(revision.source).toBe('assistant');
    expect(revision.sourceInstruction).toBe('Repair the retired GLM model reference.');
    expect(revision.operations).toHaveLength(2);
    expect(revision.operations.every((operation) => operation.type === 'updateNode')).toBe(true);

    const [published] = await db!.select().from(workflowVersions).where(eq(workflowVersions.id, 'wfv_existing')).limit(1);
    expect(published.definition?.nodes.find((candidate) => candidate.id === 'agent-1')?.config).toMatchObject({ model: 'GLM/glm-5.3' });
  });

  it('limits replacement to selected Agent nodes', async () => {
    const { workflows, created } = await setup();
    const result = await workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/gpt-5',
      nodeIds: ['agent-2'],
    });

    expect(node(result, 'agent-1').config).toMatchObject({ model: 'GLM/glm-5.3' });
    expect(node(result, 'agent-2').config).toMatchObject({ model: 'OpenAI/gpt-5' });
  });

  it('rejects a stale base revision without validating the target model again', async () => {
    const { workflows, created, assertPublicAgentModel } = await setup();
    await workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/gpt-5',
      nodeIds: ['agent-1'],
    });

    await expect(workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/gpt-5',
      nodeIds: ['agent-2'],
    })).rejects.toBeInstanceOf(ConflictException);
    expect(assertPublicAgentModel).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid target model without writing a revision', async () => {
    const assertPublicAgentModel = vi.fn<(model: string) => Promise<void>>().mockRejectedValue(new BadRequestException('The selected model is not configured for this provider.'));
    const { workflows, created } = await setup(assertPublicAgentModel);

    await expect(workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/missing',
    })).rejects.toBeInstanceOf(BadRequestException);

    const current = await workflows.get(request, 'personal', created.id);
    expect(current.draft.revisionId).toBe(created.draft.revisionId);
    expect(node(current, 'agent-1').config).toMatchObject({ model: 'GLM/glm-5.3' });
  });

  it('rejects an unknown selected node', async () => {
    const { workflows, created } = await setup();
    await expect(workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/gpt-5',
      nodeIds: ['missing'],
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a selected node that is not an Agent node', async () => {
    const { workflows, created } = await setup();
    await expect(workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'OpenAI/gpt-5',
      nodeIds: ['input'],
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a replacement with no exact source-model match', async () => {
    const { workflows, created } = await setup();
    await expect(workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'Missing/model',
      toModel: 'OpenAI/gpt-5',
    })).rejects.toBeInstanceOf(BadRequestException);

    const current = await workflows.get(request, 'personal', created.id);
    expect(current.draft.revisionId).toBe(created.draft.revisionId);
  });

  it('rejects identical source and target models before consulting the Provider catalog', async () => {
    const { workflows, created, assertPublicAgentModel } = await setup();
    await expect(workflows.replaceDraftAgentModels(request, 'personal', created.id, {
      baseRevisionId: created.draft.revisionId,
      fromModel: 'GLM/glm-5.3',
      toModel: 'GLM/glm-5.3',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(assertPublicAgentModel).not.toHaveBeenCalled();
  });
});

function canvasStickerDefinition(overrides: Record<string, unknown> = {}): StoredWorkflowDefinition {
  return {
    schemaVersion: 4,
    input: {},
    defaults: { errorPolicy: 'stop' },
    nodes: [
      {
        id: 'sticker',
        position: { x: 0, y: 0 },
        type: 'worklite/canvas-sticker',
        typeVersion: '1',
        config: { width: 512, height: 512, shape: 'roundedRect', backgroundColor: '#2563eb', cornerRadius: 32, ...overrides },
        errorPolicy: 'stop',
      },
      {
        id: 'wechat',
        position: { x: 300, y: 0 },
        type: 'wechat-official-account/publish',
        typeVersion: '2',
        config: { accountId: 'wechat_official_account_personal', mode: 'draft' },
        errorPolicy: 'stop',
      },
    ],
    edges: [
      { id: 'edge-cover', sourceNodeId: 'sticker', sourcePort: 'output', targetNodeId: 'wechat', targetPort: 'coverImage' },
    ],
  };
}

describe('WorkflowsService Canvas Sticker node validation', () => {
  it('accepts a valid Canvas Sticker node connected to the WeChat v2 cover input', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
    const resources = {} as WorkspaceResourcesService;
    const workflows = new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
    const created = await workflows.create(request, 'personal', { name: 'Sticker cover', definition: canvasStickerDefinition() });
    expect(node(created, 'sticker').type).toBe('worklite/canvas-sticker');
  });

  it('rejects a width outside the supported range', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
    const resources = {} as WorkspaceResourcesService;
    const workflows = new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
    await expect(workflows.create(request, 'personal', { name: 'Bad sticker', definition: canvasStickerDefinition({ width: 32 }) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unsupported shape', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
    const resources = {} as WorkspaceResourcesService;
    const workflows = new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
    await expect(workflows.create(request, 'personal', { name: 'Bad shape', definition: canvasStickerDefinition({ shape: 'triangle' }) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid backgroundColor', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
    const resources = {} as WorkspaceResourcesService;
    const workflows = new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
    await expect(workflows.create(request, 'personal', { name: 'Bad color', definition: canvasStickerDefinition({ backgroundColor: 'not-a-color' }) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects connecting Canvas Sticker output to a non-coverImage port', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);
    const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
    const resources = {} as WorkspaceResourcesService;
    const workflows = new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
    const invalid = canvasStickerDefinition();
    invalid.nodes[1]!.typeVersion = '1';
    invalid.nodes[1]!.config = { accountId: 'wechat_official_account_personal', mode: 'draft' };
    invalid.edges[0]!.targetPort = 'article';
    await expect(workflows.create(request, 'personal', { name: 'Bad connection', definition: invalid })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('WorkflowsService deletion', () => {
  function addVersion(workflowId: string, id = 'wfv_delete_test') {
    db!.insert(workflowVersions).values({
      id,
      workspaceId: 'workspace_personal',
      workflowId,
      version: 1,
      published: true,
      schemaVersion: 4,
      nodes: definition().nodes,
      definition: definition(),
      publishedAt: new Date(),
      publishedBy: 'You',
    }).run();
    return id;
  }

  function addRun(workflowId: string, workflowVersionId: string, status: 'queued' | 'running' | 'paused' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out', id = 'run_delete_test') {
    db!.insert(workflowRuns).values({
      id,
      workspaceId: 'workspace_personal',
      workflowId,
      workflowVersionId,
      status,
      input: {},
      ...(status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timed_out' ? { finishedAt: new Date() } : {}),
    }).run();
    return id;
  }

  function addSchedule(workflowId: string, workflowVersionId: string, enabled: boolean) {
    db!.insert(workflowSchedules).values({
      id: 'wfs_delete_test',
      workspaceId: 'workspace_personal',
      workflowId,
      workflowVersionId,
      intervalSeconds: 300,
      enabled,
      running: false,
      nextRunAt: new Date(Date.now() + 300_000),
    }).run();
  }

  function addHomeAssignment(workflowId: string) {
    db!.insert(homeBoardCategories).values({
      id: 'hbcat_delete_test',
      workspaceId: 'workspace_personal',
      name: 'Delete test',
      position: 0,
    }).run();
    db!.insert(homeBoardAssignments).values({
      workspaceId: 'workspace_personal',
      workflowId,
      categoryId: 'hbcat_delete_test',
    }).run();
  }

  async function expectWorkflowExists(workflowId: string) {
    expect(await db!.select().from(workflows).where(eq(workflows.id, workflowId))).toHaveLength(1);
  }

  it('deletes a Workflow and retains its Artifact with detached references', async () => {
    const { workflows: service, created } = await setup();
    const versionId = addVersion(created.id);
    const runId = addRun(created.id, versionId, 'succeeded');
    db!.insert(artifacts).values({
      id: 'art_delete_test',
      workspaceId: 'workspace_personal',
      workflowId: created.id,
      runId,
      name: 'Result',
      type: 'json',
      content: '{"ok":true}',
    }).run();

    await service.delete(request, 'personal', created.id);

    expect(await db!.select().from(workflows).where(eq(workflows.id, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowDrafts).where(eq(workflowDrafts.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowEditRevisions).where(eq(workflowEditRevisions.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowVersions).where(eq(workflowVersions.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowRuns).where(eq(workflowRuns.workflowId, created.id))).toHaveLength(0);
    const [artifact] = await db!.select().from(artifacts).where(eq(artifacts.id, 'art_delete_test'));
    expect(artifact).toMatchObject({ workflowId: null, runId: null });
  });

  it('rejects an active Run even when force is requested', async () => {
    const { workflows: service, created } = await setup();
    const versionId = addVersion(created.id);
    const runId = addRun(created.id, versionId, 'running');

    await expect(service.delete(request, 'personal', created.id, { force: true })).rejects.toThrow(`Run ${runId} is running`);

    await expectWorkflowExists(created.id);
    expect(await db!.select().from(workflowRuns).where(eq(workflowRuns.id, runId))).toHaveLength(1);
  });

  it('rejects an enabled schedule by default', async () => {
    const { workflows: service, created } = await setup();
    const versionId = addVersion(created.id);
    addSchedule(created.id, versionId, true);

    await expect(service.delete(request, 'personal', created.id)).rejects.toThrow('schedule is active');

    await expectWorkflowExists(created.id);
    expect(await db!.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, created.id))).toHaveLength(1);
  });

  it('rejects a Home board category assignment by default', async () => {
    const { workflows: service, created } = await setup();
    addVersion(created.id);
    addHomeAssignment(created.id);

    await expect(service.delete(request, 'personal', created.id)).rejects.toThrow('Home board category');

    await expectWorkflowExists(created.id);
    expect(await db!.select().from(homeBoardAssignments).where(eq(homeBoardAssignments.workflowId, created.id))).toHaveLength(1);
  });

  it('deletes without force after a Home board assignment is removed', async () => {
    const { workflows: service, created, workspaces } = await setup();
    addVersion(created.id);
    addHomeAssignment(created.id);
    const home = new HomeBoardCategoriesService(db!, workspaces);

    await expect(service.delete(request, 'personal', created.id)).rejects.toThrow('Home board category');

    const preferences = await home.assign(request, { workflowId: created.id, categoryId: null });
    expect(preferences.categories).toHaveLength(1);
    expect(preferences.categories[0]).toMatchObject({ id: 'hbcat_delete_test', workflowIds: [] });
    expect(await db!.select().from(homeBoardAssignments).where(eq(homeBoardAssignments.workflowId, created.id))).toHaveLength(0);

    await service.delete(request, 'personal', created.id);

    expect(await db!.select().from(workflows).where(eq(workflows.id, created.id))).toHaveLength(0);
    expect(await db!.select().from(homeBoardAssignments).where(eq(homeBoardAssignments.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(homeBoardCategories).where(eq(homeBoardCategories.id, 'hbcat_delete_test'))).toHaveLength(1);
  });

  it('force deletes schedule, Home assignment, versions and run history together', async () => {
    const { workflows: service, created } = await setup();
    const versionId = addVersion(created.id);
    addSchedule(created.id, versionId, true);
    addHomeAssignment(created.id);
    const runId = addRun(created.id, versionId, 'succeeded');
    db!.insert(artifacts).values({
      id: 'art_force_delete_test',
      workspaceId: 'workspace_personal',
      workflowId: created.id,
      runId,
      name: 'Forced result',
      type: 'markdown',
      content: '# Result',
    }).run();

    await service.delete(request, 'personal', created.id, { force: true });

    expect(await db!.select().from(workflows).where(eq(workflows.id, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(homeBoardAssignments).where(eq(homeBoardAssignments.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowVersions).where(eq(workflowVersions.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(workflowRuns).where(eq(workflowRuns.workflowId, created.id))).toHaveLength(0);
    expect(await db!.select().from(homeBoardCategories).where(eq(homeBoardCategories.id, 'hbcat_delete_test'))).toHaveLength(1);
    const [artifact] = await db!.select().from(artifacts).where(eq(artifacts.id, 'art_force_delete_test'));
    expect(artifact).toMatchObject({ workflowId: null, runId: null });
  });

  it('rolls back every earlier delete when the transaction fails', async () => {
    const { workflows: service, created } = await setup();
    const versionId = addVersion(created.id);
    addSchedule(created.id, versionId, true);
    const runId = addRun(created.id, versionId, 'succeeded');
    db!.$client.exec(`CREATE TRIGGER fail_workflow_run_delete BEFORE DELETE ON workflow_runs BEGIN SELECT RAISE(ABORT, 'forced workflow delete failure'); END`);

    await expect(service.delete(request, 'personal', created.id, { force: true })).rejects.toThrow('forced workflow delete failure');

    await expectWorkflowExists(created.id);
    expect(await db!.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, created.id))).toHaveLength(1);
    expect(await db!.select().from(workflowRuns).where(eq(workflowRuns.id, runId))).toHaveLength(1);
    expect(await db!.select().from(workflowVersions).where(eq(workflowVersions.workflowId, created.id))).toHaveLength(1);
  });
});

describe('WorkspaceResourcesService public Agent model validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function resources() {
    return new WorkspaceResourcesService({} as Database, {} as WorkspaceService, {} as SkillScriptRunnerService, {} as McpClientService);
  }

  function catalog(providers: Array<{ id: string; name: string; protocol: string; models: string[] }>) {
    return new Response(JSON.stringify(providers), { status: 200 });
  }

  it('accepts a configured model on an Agent-compatible Provider protocol', async () => {
    const fetchMock = vi.fn().mockResolvedValue(catalog([{ id: 'prov_openai', name: 'OpenAI', protocol: 'openai/responses', models: ['gpt-5'] }]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resources().assertPublicAgentModel('OpenAI/gpt-5')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:23392/worklite/providers');
  });

  it.each([
    { model: 'GLM/glm-5.3', providers: [{ id: 'prov_openai', name: 'OpenAI', protocol: 'openai/responses', models: ['gpt-5'] }], error: NotFoundException },
    { model: 'OpenAI/missing', providers: [{ id: 'prov_openai', name: 'OpenAI', protocol: 'openai/responses', models: ['gpt-5'] }], error: BadRequestException },
    { model: 'TypeSafe/model', providers: [{ id: 'prov_typesafe', name: 'TypeSafe', protocol: 'typesafe/systemone', models: ['model'] }], error: BadRequestException },
    { model: 'not-a-public-model', providers: [], error: BadRequestException },
  ])('rejects $model according to the Agent model rules', async ({ model, providers, error }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(catalog(providers)));
    await expect(resources().assertPublicAgentModel(model)).rejects.toBeInstanceOf(error);
  });
});
