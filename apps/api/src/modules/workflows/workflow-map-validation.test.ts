import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, type Database, type StoredWorkflowDefinition } from '@worklite/db';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkflowSchedulesService } from './workflow-schedules.service';
import { WorkflowsService } from './workflows.service';

let db: Database | undefined;
const request = {} as Request;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

async function setup() {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  const resources = { assertPublicAgentModel: async () => undefined } as unknown as WorkspaceResourcesService;
  return new WorkflowsService(db, workspaces, {} as WorkflowSchedulesService, resources);
}

function agent(id: string): StoredWorkflowDefinition['nodes'][number] {
  return {
    id,
    position: { x: 0, y: 0 },
    type: 'worklite/agent',
    typeVersion: '1',
    config: { model: 'pp-kimi/kimi-k3', systemPrompt: 'prompt', skillIds: [], mcpServerIds: [], outputFormat: 'text' },
    errorPolicy: 'stop',
  };
}

function mapNode(config: Record<string, unknown>): StoredWorkflowDefinition['nodes'][number] {
  return { id: 'map', position: { x: 0, y: 0 }, type: 'worklite/map', typeVersion: '1', config, errorPolicy: 'stop' };
}

function definition(nodes: StoredWorkflowDefinition['nodes'], edges: StoredWorkflowDefinition['edges'] = []): StoredWorkflowDefinition {
  return { schemaVersion: 4, input: {}, defaults: { errorPolicy: 'stop' }, nodes, edges };
}

describe('WorkflowsService array map, join, and compose validation', () => {
  it('accepts a map node whose subgraph is a single Agent step', async () => {
    const workflows = await setup();
    const created = await workflows.create(request, 'personal', {
      name: 'Map valid',
      definition: definition([mapNode({ subgraph: { nodes: [agent('script')], edges: [] } })]),
    });
    expect(created.draft.definition.nodes[0]?.type).toBe('worklite/map');
  });

  it('rejects a side-effecting node inside a map subgraph', async () => {
    const workflows = await setup();
    const artifact = { id: 'artifact', position: { x: 0, y: 0 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'A', type: 'text' }, errorPolicy: 'stop' as const };
    await expect(workflows.create(request, 'personal', {
      name: 'Map artifact',
      definition: definition([mapNode({ subgraph: { nodes: [artifact], edges: [] } })]),
    })).rejects.toThrow('cannot run inside a Map');
  });

  it('rejects nested map nodes', async () => {
    const workflows = await setup();
    const nested = mapNode({ subgraph: { nodes: [agent('inner')], edges: [] } });
    await expect(workflows.create(request, 'personal', {
      name: 'Nested map',
      definition: definition([mapNode({ subgraph: { nodes: [nested], edges: [] } })]),
    })).rejects.toThrow('cannot run inside a Map');
  });

  it('rejects a map binding that references a missing node', async () => {
    const workflows = await setup();
    await expect(workflows.create(request, 'personal', {
      name: 'Bad binding',
      definition: definition([mapNode({
        subgraph: { nodes: [agent('script')], edges: [] },
        bindings: [{ nodeId: 'missing', field: 'key', path: 'item.key' }],
      })]),
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a map subgraph cycle that has no bounded edge', async () => {
    const workflows = await setup();
    await expect(workflows.create(request, 'personal', {
      name: 'Unbounded map cycle',
      definition: definition([mapNode({
        subgraph: {
          nodes: [agent('a'), agent('b')],
          edges: [
            { id: 'a-b', sourceNodeId: 'a', sourcePort: 'output', targetNodeId: 'b', targetPort: 'context' },
            { id: 'b-a', sourceNodeId: 'b', sourcePort: 'output', targetNodeId: 'a', targetPort: 'context' },
          ],
        },
      })]),
    })).rejects.toThrow('maximum traversal count');
  });

  it('rejects an exhausted-budget feedback edge that targets a join barrier', async () => {
    const workflows = await setup();
    const join = { id: 'join', position: { x: 0, y: 0 }, type: 'worklite/join', typeVersion: '1', config: {}, errorPolicy: 'stop' as const };
    await expect(workflows.create(request, 'personal', {
      name: 'Join feedback',
      definition: definition([agent('a'), join], [
        { id: 'a-join', sourceNodeId: 'a', sourcePort: 'output', targetNodeId: 'join', targetPort: 'input', maxTraversals: 1 },
      ]),
    })).rejects.toThrow('cannot target a Join');
  });

  it('rejects a conditional edge that targets a join barrier', async () => {
    const workflows = await setup();
    const join = { id: 'join', position: { x: 0, y: 0 }, type: 'worklite/join', typeVersion: '1', config: {}, errorPolicy: 'stop' as const };
    const reviewer = agent('reviewer');
    reviewer.config = { ...(reviewer.config as Record<string, unknown>), outputFormat: 'json', outputContract: ['revise'] };
    await expect(workflows.create(request, 'personal', {
      name: 'Join conditional',
      definition: definition([reviewer, join], [
        {
          id: 'reviewer-join',
          sourceNodeId: 'reviewer',
          sourcePort: 'output',
          targetNodeId: 'join',
          targetPort: 'input',
          condition: { kind: 'predicate', path: '$.revise', operator: 'equals', value: true },
        },
      ]),
    })).rejects.toThrow('conditional edge cannot target a Join');
  });

  it('rejects invalid compose and image path configuration', async () => {
    const workflows = await setup();
    const compose = { id: 'compose', position: { x: 0, y: 0 }, type: 'worklite/compose-article', typeVersion: '1', config: { unusedImagePolicy: 'keep' }, errorPolicy: 'stop' as const };
    await expect(workflows.create(request, 'personal', {
      name: 'Bad compose',
      definition: definition([compose]),
    })).rejects.toBeInstanceOf(BadRequestException);

    const image = {
      id: 'cover',
      position: { x: 0, y: 0 },
      type: 'worklite/image',
      typeVersion: '1',
      config: { model: 'codex/gpt-image-2', n: 1, background: 'opaque', quality: 'medium', size: '1024x1024', promptPath: 'not a path' },
      errorPolicy: 'stop' as const,
    };
    await expect(workflows.create(request, 'personal', {
      name: 'Bad image path',
      definition: definition([image]),
    })).rejects.toThrow('promptPath');
  });

  it('rejects allowEmptyOutputKeys outside the Agent output contract', async () => {
    const workflows = await setup();
    const node = agent('planner');
    node.config = { ...(node.config as Record<string, unknown>), outputFormat: 'json', outputContract: ['title'], allowEmptyOutputKeys: ['images'] };
    await expect(workflows.create(request, 'personal', {
      name: 'Bad empty keys',
      definition: definition([node]),
    })).rejects.toThrow('allowEmptyOutputKeys');
  });

  it('permits generated images into compose image inputs but not into ordinary JSON Agent context', async () => {
    const workflows = await setup();
    const image = {
      id: 'cover',
      position: { x: 0, y: 0 },
      type: 'worklite/image',
      typeVersion: '1',
      config: { model: 'codex/gpt-image-2', n: 1, background: 'opaque', quality: 'medium', size: '1024x1024' },
      errorPolicy: 'stop' as const,
    };
    const compose = { id: 'compose', position: { x: 0, y: 0 }, type: 'worklite/compose-article', typeVersion: '1', config: {}, errorPolicy: 'stop' as const };
    const allowed = await workflows.create(request, 'personal', {
      name: 'Compose image',
      definition: definition([image, compose], [
        { id: 'cover-compose', sourceNodeId: 'cover', sourcePort: 'output', targetNodeId: 'compose', targetPort: 'coverImage' },
      ]),
    });
    expect(allowed.draft.definition.edges).toHaveLength(1);

    await expect(workflows.create(request, 'personal', {
      name: 'Image into agent',
      definition: definition([image, agent('consumer')], [
        { id: 'cover-agent', sourceNodeId: 'cover', sourcePort: 'output', targetNodeId: 'consumer', targetPort: 'context' },
      ]),
    })).rejects.toThrow('Generated image output may connect only');
  });

  it('permits a map whose terminal renders an image to feed WeChat images', async () => {
    const workflows = await setup();
    const render = {
      id: 'render',
      position: { x: 0, y: 0 },
      type: 'worklite/canvas-render',
      typeVersion: '1',
      config: { width: 1080, height: 720, key: 'image' },
      errorPolicy: 'stop' as const,
    };
    const map = mapNode({ subgraph: { nodes: [render], edges: [] }, outputNodeId: 'render' });
    const wechat = {
      id: 'wechat',
      position: { x: 0, y: 0 },
      type: 'wechat-official-account/publish',
      typeVersion: '2',
      config: { accountId: 'wechat_official_account_personal', mode: 'draft' },
      errorPolicy: 'stop' as const,
    };
    const created = await workflows.create(request, 'personal', {
      name: 'Map to WeChat images',
      definition: definition([map, wechat], [
        { id: 'map-wechat', sourceNodeId: 'map', sourcePort: 'output', targetNodeId: 'wechat', targetPort: 'images' },
      ]),
    });
    expect(created.draft.definition.edges).toHaveLength(1);
  });

  it('rejects a map whose terminal is not an image producer when it feeds WeChat images', async () => {
    const workflows = await setup();
    const map = mapNode({ subgraph: { nodes: [agent('step')], edges: [] }, outputNodeId: 'step' });
    const wechat = {
      id: 'wechat',
      position: { x: 0, y: 0 },
      type: 'wechat-official-account/publish',
      typeVersion: '2',
      config: { accountId: 'wechat_official_account_personal', mode: 'draft' },
      errorPolicy: 'stop' as const,
    };
    await expect(workflows.create(request, 'personal', {
      name: 'Text map to WeChat images',
      definition: definition([map, wechat], [
        { id: 'map-wechat', sourceNodeId: 'map', sourcePort: 'output', targetNodeId: 'wechat', targetPort: 'images' },
      ]),
    })).rejects.toThrow('Generated image output may connect only');
  });
});
