import { eq } from 'drizzle-orm';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, workflowEditRevisions, workflowVersions, type Database, type StoredWorkflowDefinition } from '@worklite/db';
import type { WorkflowDetailView } from '@worklite/contracts';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import type { McpClientService } from '../mcp-servers/mcp-client.service';
import { WorkflowSchedulesService } from './workflow-schedules.service';
import { WorkflowsService } from './workflows.service';

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
  return { workflows, created, assertPublicAgentModel };
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
