import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { createDb, initializeDatabase, skills, wechatOfficialAccounts, type StoredWorkflowDefinition } from '@worklite/db';
import {
  commitWorkflowInvocation,
  composeWorkflowArticle,
  createWorkflowSchedulerState,
  executeWorkflowMap,
  resolveWorkflowNodeCapability,
  takeNextWorkflowInvocation,
} from '@worklite/workflow-engine';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkflowSchedulesService } from './workflow-schedules.service';
import { WorkflowsService } from './workflows.service';

// Snapshot of the redrawn article workflow draft (Map for images + Compose gate).
// The published versions cannot be edited, so this fixture keeps the draft graph
// under regression coverage until it is published.
const definition = JSON.parse(
  readFileSync(join(process.cwd(), 'apps/api/src/modules/workflows/fixtures/redrawn-article-workflow.json'), 'utf8'),
) as StoredWorkflowDefinition;
const request = {} as Request;

const PLANNER = 'wn_7744e0e2-9653-47ae-977e-569b565dd1ce';
const WRITER = 'wn_d37922f4-c1fc-4692-aac7-fb1a4539f22f';

async function setup() {
  const db = createDb(':memory:');
  await initializeDatabase(db);
  await db.insert(skills).values([
    { id: 'sk_029f68e6-1b9e-4a65-a230-be02a78e5521', workspaceId: 'workspace_personal', name: 'github-current-popularity', source: 'local', root: 'platform', validation: 'valid' },
    { id: 'sk_fa6143da-e62d-4a16-bbf8-bd8df148dba2', workspaceId: 'workspace_personal', name: 'zhihu-research', source: 'local', root: 'platform', validation: 'valid' },
    { id: 'sk_ea37cc32-6f30-47d1-a120-2ebef9321d30', workspaceId: 'workspace_personal', name: 'official-docs-fetch', source: 'local', root: 'platform', validation: 'valid' },
  ]);
  await db.insert(wechatOfficialAccounts).values({
    id: 'wechat_official_account_personal',
    workspaceId: 'workspace_personal',
    displayName: 'Personal',
    status: 'disconnected',
  }).onConflictDoNothing();
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  const resources = { assertPublicAgentModel: async () => undefined, reconcileWorkspaceSkills: async () => undefined } as unknown as WorkspaceResourcesService;
  const schedules = { syncPublishedVersion: async () => undefined } as unknown as WorkflowSchedulesService;
  return { db, service: new WorkflowsService(db, workspaces, schedules, resources) };
}

describe('redrawn article workflow', () => {
  it('passes draft and publication-level validation', async () => {
    const { db, service } = await setup();
    const created = await service.create(request, 'personal', { name: 'redrawn article', definition });
    const version = await service.publish(request, 'personal', created.id);
    expect(version.version).toBe(1);
    expect(version.definition.nodes).toHaveLength(9);
    expect(version.definition.edges).toHaveLength(14);
    db.$client.close();
  });

  function image(key: string) {
    return { type: 'workflow_image', model: 'canvas-render', mediaType: 'image/png', key, data: [{ b64Json: 'AAAA' }] };
  }
  const cover = { type: 'workflow_image', model: 'codex/gpt-image-2', mediaType: 'image/png', data: [{ b64Json: 'COVER' }] };
  const plan = {
    title: '演示标题',
    topic: '演示主题',
    readerQuestions: ['这是什么'],
    findings: [{ claim: '结论', detail: '细节', source: 'src', quote: '引文' }],
    outline: [{ heading: '一', points: ['要点'] }],
    images: [
      { key: 'fig-a', intent: '讲清结构', evidence: '引文' },
      { key: 'fig-b', intent: '讲清差别', evidence: '结论' },
    ],
    coverPrompt: 'english prompt',
  };

  async function drive(alwaysRevise: boolean) {
    const graph = definition as unknown as import('@worklite/contracts').WorkflowDefinition;
    const state = createWorkflowSchedulerState(graph);
    const order: string[] = [];
    let writerRuns = 0;
    let reviewerRuns = 0;
    let composed: string | undefined;
    let wechatInput: Record<string, unknown> | undefined;
    let artifactInput: unknown;

    while (true) {
      const invocation = takeNextWorkflowInvocation(state);
      if (!invocation) break;
      order.push(invocation.nodeId);
      const node = graph.nodes.find((entry) => entry.id === invocation.nodeId)!;
      const capability = resolveWorkflowNodeCapability(node.type, node.typeVersion)!;
      let output: unknown;
      switch (node.type) {
        case 'worklite/input':
          output = '一个想法';
          break;
        case 'worklite/agent': {
          if (node.id === PLANNER) output = plan;
          else if (node.id === WRITER) {
            writerRuns += 1;
            const article = writerRuns === 1
              ? '# 演示标题\n\n第一版 ![结构](worklite-image:fig-a)'
              : '# 演示标题\n\n第二版 ![结构](worklite-image:fig-a) ![差别](worklite-image:fig-b)';
            output = {
              title: '演示标题',
              article,
              evidenceUsed: ['src'],
              ...Object.fromEntries(['topic', 'readerQuestions', 'findings', 'outline', 'images', 'coverPrompt'].map((key) => [key, (invocation.input.context as Record<string, unknown>)[key]])),
            };
          } else {
            reviewerRuns += 1;
            const context = invocation.input.context as Record<string, unknown>;
            output = {
              revise: alwaysRevise || reviewerRuns === 1,
              notes: '改进说明',
              ...Object.fromEntries(['title', 'article', 'topic', 'readerQuestions', 'findings', 'outline', 'images', 'coverPrompt'].map((key) => [key, context[key]])),
            };
          }
          break;
        }
        case 'worklite/map':
          output = await executeWorkflowMap({
            itemsValue: invocation.input.items,
            context: invocation.input.context,
            config: node.config,
            signal: new AbortController().signal,
            executeNode: async ({ node: nested, config }) => nested.type === 'worklite/canvas-render'
              ? image((config as { key: string }).key)
              : 'ctx.fillRect(0,0,10,10);',
          });
          break;
        case 'worklite/image':
          output = cover;
          break;
        case 'worklite/compose-article':
          output = composeWorkflowArticle(invocation.input, node.config);
          composed = output as string;
          break;
        case 'worklite/artifact':
          artifactInput = invocation.input.data;
          output = invocation.input.data;
          break;
        case 'wechat-official-account/publish':
          wechatInput = invocation.input;
          output = { draftId: 'draft' };
          break;
        default:
          throw new Error(`unexpected node ${node.type} ${capability.id}`);
      }
      commitWorkflowInvocation(graph, state, invocation.nodeId, output);
    }
    return { order, writerRuns, reviewerRuns, composed, wechatInput, artifactInput };
  }

  it('routes one revision, expands images in list order, and feeds both outputs', async () => {
    const result = await drive(false);
    expect(result.writerRuns).toBe(2);
    expect(result.reviewerRuns).toBe(2);
    expect(result.composed).toBe('# 演示标题\n\n第二版 ![结构](worklite-image:fig-a) ![差别](worklite-image:fig-b)');
    expect(result.artifactInput).toBe(result.composed);
    expect(result.wechatInput?.article).toBe(result.composed);
    expect(result.wechatInput?.images).toEqual([[image('fig-a'), image('fig-b')]]);
    expect(result.wechatInput?.coverImage).toEqual(cover);
  });

  it('stops revising after the bounded edge is exhausted and still composes', async () => {
    const result = await drive(true);
    expect(result.writerRuns).toBe(2);
    expect(result.reviewerRuns).toBe(2);
    expect(result.composed).toContain('第二版');
  });
});
