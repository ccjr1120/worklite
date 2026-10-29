import { eq } from 'drizzle-orm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  agentMcpServers,
  agentTeamVersions,
  executorCategories,
  agents,
  createDb,
  initializeDatabase,
  mcpServers,
  workflowDrafts,
  workflowEditRevisions,
  workflowVersions,
  workflows,
  type Database,
  type StoredAgentTeamRoleConfiguration,
  type StoredWorkflowDefinition,
} from '@worklite/db';
import type { McpServerReferenceReport } from '@worklite/contracts';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import type { McpClientService } from '../mcp-servers/mcp-client.service';

let db: Database | undefined;

const request = {} as Request;
const WORKSPACE_ID = 'workspace_personal';
const SERVER_ID = 'mcp_test_server';

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

function agentNode(id: string, mcpServerIds: string[]): StoredWorkflowDefinition['nodes'][number] {
  return {
    id,
    position: { x: 0, y: 0 },
    type: 'worklite/agent',
    typeVersion: '1',
    config: { model: 'GLM/glm-5.3', systemPrompt: 'prompt', skillIds: [], mcpServerIds, outputFormat: 'text', maxToolCalls: 3 },
    errorPolicy: 'stop',
  };
}

function definition(mcpServerIds: string[]): StoredWorkflowDefinition {
  return {
    schemaVersion: 4,
    input: {},
    defaults: { errorPolicy: 'stop' },
    nodes: [
      { id: 'input', position: { x: -240, y: 0 }, type: 'worklite/input', typeVersion: '1', config: {}, errorPolicy: 'stop' },
      agentNode('agent-1', mcpServerIds),
    ],
    edges: [],
  };
}

function teamRole(mcpServerIds: string[]): StoredAgentTeamRoleConfiguration {
  return {
    role: 'developer',
    publicModelId: 'GLM/glm-5.3',
    instructions: '',
    entryPoints: [],
    skills: [],
    mcpServers: mcpServerIds.map((id) => ({ id, name: 'Project info', allowedToolNames: [] })),
    toolNames: [],
  };
}

async function setup() {
  db = createDb(':memory:');
  await initializeDatabase(db);
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  const resources = new WorkspaceResourcesService(db, workspaces, {} as SkillScriptRunnerService, {} as McpClientService, {} as never);
  db.insert(mcpServers).values({ id: SERVER_ID, workspaceId: WORKSPACE_ID, name: 'Project info', endpoint: 'https://mcp.example.com/mcp' }).run();
  return { resources };
}

function seedWorkflow(mcpServerIds: string[], options: { publishedVersion?: boolean } = {}) {
  db!.insert(workflows).values({ id: 'wf_1', workspaceId: WORKSPACE_ID, name: 'Research' }).run();
  db!.insert(workflowDrafts).values({ id: 'wfd_1', workspaceId: WORKSPACE_ID, workflowId: 'wf_1', currentRevisionId: 'wfr_base', definition: definition(mcpServerIds) }).run();
  if (options.publishedVersion) {
    db!.insert(workflowVersions).values({ id: 'wfv_1', workspaceId: WORKSPACE_ID, workflowId: 'wf_1', version: 1, published: true, definition: definition(mcpServerIds) }).run();
  }
}

function seedAgentTeam(mcpServerIds: string[], options: { capturedVersion?: boolean } = {}) {
  db!.insert(executorCategories).values({
    id: 'team_1',
    workspaceId: WORKSPACE_ID,
    name: 'Delivery',
    description: '',
    processId: 'process',
    processVersion: '1',
    roles: [teamRole(mcpServerIds)],
  }).run();
  if (options.capturedVersion) {
    db!.insert(agentTeamVersions).values({
      id: 'teamv_1',
      workspaceId: WORKSPACE_ID,
      executorCategoryId: 'team_1',
      version: 1,
      snapshot: {
        processId: 'process',
        processVersion: '1',
        developerExecution: { kind: 'codex_app_server' },
        roles: [teamRole(mcpServerIds)],
        processFiles: [],
        recipeDefaults: { maxRepairRounds: 1 },
      },
    }).run();
  }
}

function badRequestReferences(error: unknown): McpServerReferenceReport {
  expect(error).toBeInstanceOf(BadRequestException);
  const response = (error as BadRequestException).getResponse() as { message: string; references: McpServerReferenceReport };
  expect(typeof response.message).toBe('string');
  return response.references;
}

describe('WorkspaceResourcesService.platformSnapshot', () => {
  it('advertises the general Chat terminal without a command allow-list', async () => {
    const { resources } = await setup();
    vi.spyOn(resources, 'providers').mockResolvedValue([]);

    const snapshot = await resources.platformSnapshot(request, 'personal');

    expect(snapshot.capabilities.troubleshooting.chatHostTools).toEqual(['run_host_command']);
    expect(snapshot.capabilities.chatShell).toMatchObject({
      available: true,
      tool: 'run_host_command',
      runtime: '/bin/zsh -lc',
      commandPolicy: 'arbitrary local shell commands; no command allow-list',
      automaticReplay: false,
    });
    expect(snapshot.capabilities.chatCapabilities.orchestration.localCommandTarget).toContain('run_host_command');
  });
});

describe('WorkspaceResourcesService.deleteMcpServer', () => {
  it('rejects an unknown server with 404', async () => {
    const { resources } = await setup();
    await expect(resources.deleteMcpServer(request, 'personal', 'mcp_missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes an unreferenced server without force', async () => {
    const { resources } = await setup();
    const result = await resources.deleteMcpServer(request, 'personal', SERVER_ID);
    expect(result).toEqual({ deleted: SERVER_ID, force: false, cleaned: { workflowDrafts: 0, agentTeamRoles: 0 } });
    expect(db!.select().from(mcpServers).where(eq(mcpServers.id, SERVER_ID)).all()).toHaveLength(0);
  });

  it('removes a legacy Chat assignment through the cascading foreign key without force', async () => {
    const { resources } = await setup();
    // The built-in Chat agent row is seeded by initializeDatabase.
    db!.insert(agentMcpServers).values({ agentId: 'agt_system_helper_chat', mcpServerId: SERVER_ID }).run();
    await resources.deleteMcpServer(request, 'personal', SERVER_ID);
    expect(db!.select().from(mcpServers).where(eq(mcpServers.id, SERVER_ID)).all()).toHaveLength(0);
    expect(db!.select().from(agentMcpServers).where(eq(agentMcpServers.mcpServerId, SERVER_ID)).all()).toHaveLength(0);
  });

  it('rejects a referenced server without force and reports every concrete location', async () => {
    const { resources } = await setup();
    seedWorkflow([SERVER_ID], { publishedVersion: true });
    seedAgentTeam([SERVER_ID], { capturedVersion: true });

    const error = await resources.deleteMcpServer(request, 'personal', SERVER_ID).catch((caught: unknown) => caught);
    const references = badRequestReferences(error);
    expect(references.workflowDrafts).toEqual([{ workflowId: 'wf_1', workflowName: 'Research', nodeIds: ['agent-1'] }]);
    expect(references.workflowVersions).toEqual([{ workflowId: 'wf_1', workflowName: 'Research', version: 1, nodeIds: ['agent-1'] }]);
    expect(references.agentTeamRoles).toEqual([{ executorCategoryId: 'team_1', teamName: 'Delivery', role: 'developer', displayName: null }]);
    expect(references.agentTeamVersions).toEqual([{ executorCategoryId: 'team_1', versionId: 'teamv_1', version: 1, roles: ['developer'] }]);
    expect((error as BadRequestException).message).toContain('Research');
    expect((error as BadRequestException).message).toContain('Delivery');
    // Nothing was deleted or rewritten.
    expect(db!.select().from(mcpServers).where(eq(mcpServers.id, SERVER_ID)).all()).toHaveLength(1);
  });

  it('force deletes the server and cleans draft and Team role references in one transaction, leaving published history untouched', async () => {
    const { resources } = await setup();
    seedWorkflow([SERVER_ID, 'mcp_other'], { publishedVersion: true });
    seedAgentTeam([SERVER_ID], { capturedVersion: true });

    const result = await resources.deleteMcpServer(request, 'personal', SERVER_ID, { force: true });
    expect(result).toEqual({ deleted: SERVER_ID, force: true, cleaned: { workflowDrafts: 1, agentTeamRoles: 1 } });
    expect(db!.select().from(mcpServers).where(eq(mcpServers.id, SERVER_ID)).all()).toHaveLength(0);

    const [draft] = db!.select().from(workflowDrafts).where(eq(workflowDrafts.id, 'wfd_1')).all();
    const cleanedNode = draft.definition.nodes.find((node) => node.id === 'agent-1')!;
    expect((cleanedNode.config as { mcpServerIds: string[] }).mcpServerIds).toEqual(['mcp_other']);
    expect(draft.currentRevisionId).not.toBe('wfr_base');
    const [revision] = db!.select().from(workflowEditRevisions).where(eq(workflowEditRevisions.id, draft.currentRevisionId!)).all();
    expect(revision.parentRevisionId).toBe('wfr_base');
    expect(revision.source).toBe('migration');
    expect(revision.snapshot).toEqual(draft.definition);

    const [team] = db!.select().from(executorCategories).where(eq(executorCategories.id, 'team_1')).all();
    expect(team.roles[0]!.mcpServers).toEqual([]);

    // Immutable history keeps its references.
    const [version] = db!.select().from(workflowVersions).where(eq(workflowVersions.id, 'wfv_1')).all();
    const versionNode = version.definition!.nodes.find((node) => node.id === 'agent-1')!;
    expect((versionNode.config as { mcpServerIds: string[] }).mcpServerIds).toEqual([SERVER_ID, 'mcp_other']);
    const [teamVersion] = db!.select().from(agentTeamVersions).where(eq(agentTeamVersions.id, 'teamv_1')).all();
    expect(teamVersion.snapshot.roles[0]!.mcpServers.map((server) => server.id)).toEqual([SERVER_ID]);
  });

  it('rejects deletion under force when a non-Chat Agent is assigned the server', async () => {
    const { resources } = await setup();
    db!.insert(agents).values({ id: 'agt_custom', workspaceId: WORKSPACE_ID, name: 'Researcher', responsibility: '', model: 'GLM/glm-5.3' }).run();
    db!.insert(agentMcpServers).values({ agentId: 'agt_custom', mcpServerId: SERVER_ID }).run();

    const error = await resources.deleteMcpServer(request, 'personal', SERVER_ID, { force: true }).catch((caught: unknown) => caught);
    const references = badRequestReferences(error);
    expect(references.agents).toEqual([{ agentId: 'agt_custom', agentName: 'Researcher' }]);
    expect(db!.select().from(mcpServers).where(eq(mcpServers.id, SERVER_ID)).all()).toHaveLength(1);
  });
});
