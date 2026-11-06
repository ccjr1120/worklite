// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, agentExecutions, scheduledAgentTasks, createDb, initializeDatabase, type Database } from '@worklite/db';
import { AgentCollaborationService } from './agent-collaboration.service';
import { initializeAgentFiles } from './agent-file-store';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { WorkspaceService } from '../teams/teams.service';
import { WorkspaceResourcesService } from '../teams/team-resources.service';

const workspace = 'workspace_personal';
const request = {} as Request;
const definition = { providerId: null, model: '', skillIds: [], mcpServerIds: [], name: 'Agent', responsibility: 'Work', systemPrompt: 'Use evidence', collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } };
let db: Database;
let directory: string;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db?.$client.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  mkdirSync('.data', { recursive: true });
  directory = mkdtempSync(resolve('.data/test-agent-rules-'));
  db = createDb(':memory:');
  await initializeDatabase(db);
  const root = join(directory, 'agents');
  const catalog = initializeAgentFiles(db, root);
  const resources = { reconcileWorkspaceSkills: async () => {}, workflowMcpRuntimes: async () => [], resolveSkillIds: async (_workspace: string, ids: string[]) => ids };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  const service = new AgentsService(db, new WorkspaceService(db), resources as never);
  const lead = await service.create(request, 'personal', { ...definition, name: 'lead' });
  return { service, catalog, root, lead, resources };
}

describe('Agent ownership and transactional package lifecycle', () => {
  it.each(['agt_c245b098-2306-491f-b780-1c06f280549e', 'agt_41ff4510f047af4743729f20cf1d15c4'])('deletes a scoped child with either historical id format: %s', async (id) => {
    const { service, catalog, lead } = await setup();
    const child = await service.create(request, 'personal', { ...definition, parentAgentId: lead.id });
    const path = join(catalog.get(child.id)!.directory, 'AGENT.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(child.id, id));
    catalog.refresh(workspace);
    expect((await service.get(request, 'personal', lead.id)).collaboration!.subAgentIds).toEqual([id]);
    await service.delete(request, 'personal', id, lead.id);
    expect((await service.get(request, 'personal', lead.id)).collaboration!.subAgentIds).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it.each(['codex', 'claude'] as const)('publishes a %s package that remains discoverable after restart', async (kind) => {
    const { service, root } = await setup();
    const agent = await service.create(request, 'personal', { ...definition, name: kind, runtime: { kind, projectDirectory: directory } });
    const path = join(root, kind);
    expect(readFileSync(join(path, 'AGENT.md'), 'utf8')).toContain(`id: ${agent.id}`);
    expect(existsSync(join(path, 'tools'))).toBe(false);
    expect(existsSync(join(path, 'subagents'))).toBe(false);
    expect((await service.list(request, 'personal')).map((row) => row.id)).toContain(agent.id);
    expect((await service.get(request, 'personal', agent.id)).id).toBe(agent.id);
    initializeAgentFiles(db, root);
    expect((await service.get(request, 'personal', agent.id)).runtime).toMatchObject({ kind, projectDirectory: directory });
  });

  it('reads legacy empty adapter scaffolding but rejects actual owned tool files', async () => {
    const { service, catalog, root } = await setup();
    const agent = await service.create(request, 'personal', { ...definition, name: 'codex', runtime: { kind: 'codex', projectDirectory: '' } });
    mkdirSync(join(root, 'codex/tools'));
    mkdirSync(join(root, 'codex/subagents'));
    initializeAgentFiles(db, root);
    expect((await service.get(request, 'personal', agent.id)).id).toBe(agent.id);
    writeFileSync(join(root, 'codex/tools/script.mjs'), 'console.log("unsupported private tool");');
    expect(() => catalog.refresh(workspace, root, false)).toThrow('cannot own tools/ or subagents/ contents');
  });

  it('cascades a private subtree, disables its schedules, retains history and updates ownership across restart', async () => {
    const { service, catalog, root, lead } = await setup();
    const child = await service.create(request, 'personal', { ...definition, name: 'child', parentAgentId: lead.id });
    const grandchild = await service.create(request, 'personal', { ...definition, name: 'grandchild', parentAgentId: child.id });
    db.insert(agentExecutions).values({ id: 'history', workspaceId: workspace, agentId: grandchild.id, status: 'completed' }).run();
    db.insert(scheduledAgentTasks).values({ id: 'schedule', workspaceId: workspace, agentId: grandchild.id, label: 'Task', prompt: 'Work', intervalSeconds: 600 }).run();
    await service.delete(request, 'personal', child.id, lead.id);
    expect((await service.get(request, 'personal', lead.id)).collaboration!.subAgentIds).toEqual([]);
    expect(catalog.get(child.id)).toBeUndefined();
    expect(catalog.get(grandchild.id)).toBeUndefined();
    expect(db.select().from(scheduledAgentTasks).get()).toMatchObject({ enabled: false, running: false });
    expect(db.select().from(agentExecutions).get()!.id).toBe('history');
    initializeAgentFiles(db, root);
    expect((await service.list(request, 'personal')).map((row) => row.id)).toEqual([lead.id]);
    await expect(service.get(request, 'personal', child.id, lead.id)).rejects.toThrow('scope');
    await service.delete(request, 'personal', lead.id);
    expect(readdirSync(root)).toEqual([]);
  });

  it('deletes an owner with all descendants in one operation without promoting children', async () => {
    const { service, root, lead } = await setup();
    const child = await service.create(request, 'personal', { ...definition, parentAgentId: lead.id });
    await service.create(request, 'personal', { ...definition, parentAgentId: child.id });
    await service.delete(request, 'personal', lead.id);
    initializeAgentFiles(db, root);
    expect(await service.list(request, 'personal')).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    expect(db.select().from(agents).where(eq(agents.id, child.id)).get()!.collaboration!.subAgentIds).toEqual([]);
  });

  it('checks active descendants before changing any files', async () => {
    const { service, root, lead } = await setup();
    const child = await service.create(request, 'personal', { ...definition, parentAgentId: lead.id });
    db.insert(agentExecutions).values({ id: 'active', workspaceId: workspace, agentId: child.id, status: 'running' }).run();
    await expect(service.delete(request, 'personal', lead.id)).rejects.toThrow('active');
    expect(existsSync(join(root, 'lead/AGENT.md'))).toBe(true);
    expect((await service.get(request, 'personal', lead.id)).subAgents![0]!.id).toBe(child.id);
  });

  it('does not let unrelated invalid packages block a scoped deletion or lose their files', async () => {
    const { service, root, lead } = await setup();
    const child = await service.create(request, 'personal', { ...definition, parentAgentId: lead.id });
    mkdirSync(join(root, 'broken'));
    const broken = join(root, 'broken/AGENT.md');
    writeFileSync(broken, '---\nid: [bad\n---\n');
    await service.delete(request, 'personal', child.id, lead.id);
    expect(readFileSync(broken, 'utf8')).toBe('---\nid: [bad\n---\n');
    expect((await service.get(request, 'personal', lead.id)).subAgents).toBeUndefined();
  });

  it('rolls deletion back if the database projection fails', async () => {
    const { service, catalog, lead } = await setup();
    const child = await service.create(request, 'personal', { ...definition, parentAgentId: lead.id });
    const path = catalog.get(child.id)!.directory;
    const refresh = catalog.refresh.bind(catalog);
    vi.spyOn(catalog, 'refresh').mockImplementation((...args) => {
      if (!existsSync(path)) throw new Error('Projection write failed');
      return refresh(...args);
    });
    await expect(service.delete(request, 'personal', child.id, lead.id)).rejects.toThrow('Projection write failed');
    expect(existsSync(join(path, 'AGENT.md'))).toBe(true);
    expect(db.select().from(agents).where(eq(agents.id, lead.id)).get()!.collaboration!.subAgentIds).toContain(child.id);
    expect(catalog.get(child.id)?.parentId).toBe(lead.id);
  });

  it('rolls back files, rows and in-memory entries when final-location validation fails', async () => {
    const { service, catalog, root, lead } = await setup();
    const before = readFileSync(join(root, 'lead/AGENT.md'), 'utf8');
    const refresh = catalog.refresh.bind(catalog);
    let strictReads = 0;
    vi.spyOn(catalog, 'refresh').mockImplementation((workspaceId, sourceRoot, project) => {
      if (sourceRoot === root && project === false && ++strictReads === 2) throw new Error('Final location could not be read');
      return refresh(workspaceId, sourceRoot, project);
    });
    await expect(service.create(request, 'personal', { ...definition, name: 'new' })).rejects.toThrow('Final location could not be read');
    expect(readdirSync(root)).toEqual(['lead']);
    expect(readdirSync(directory)).toEqual(['agents']);
    expect(readFileSync(join(root, 'lead/AGENT.md'), 'utf8')).toBe(before);
    expect(db.select().from(agents).where(eq(agents.kind, 'custom')).all().map((row) => row.id)).toEqual([lead.id]);
    expect(catalog.get(lead.id)?.directory).toBe(join(root, 'lead'));
  });

  it('rejects an invalid staged package without leaving a row or directory', async () => {
    const { service, root } = await setup();
    await expect(service.create(request, 'personal', { ...definition, name: 'bad', collaboration: { ...definition.collaboration, outputContract: [123] as never } })).rejects.toThrow('outputContract');
    expect(readdirSync(root)).toEqual(['lead']);
    expect(readdirSync(directory)).toEqual(['agents']);
    expect(db.select().from(agents).where(eq(agents.name, 'bad')).get()).toBeUndefined();
  });

  it('discovers a newly authored package by id without requiring a list request first', async () => {
    const { service, root } = await setup();
    mkdirSync(join(root, 'authored'));
    writeFileSync(join(root, 'authored/AGENT.md'), '---\nid: agt_authored\nname: authored\nruntime:\n  kind: codex\n---\nInstructions');
    expect((await service.get(request, 'personal', 'agt_authored')).name).toBe('authored');
  });

  it('hides private ids from global choices and enforces parent-scoped CRUD', async () => {
    const { service, lead, resources } = await setup();
    const child = await service.create(request, 'personal', { ...definition, name: 'private-child', parentAgentId: lead.id });
    const stranger = await service.create(request, 'personal', { ...definition, name: 'stranger' });
    const collaboration = new AgentCollaborationService(db, resources as never, {} as never, {} as never);
    expect(collaboration.list(workspace).map((row) => row.id)).toEqual([lead.id, stranger.id]);
    expect(JSON.stringify(await service.list(request, 'personal'))).not.toContain(child.id);
    const platform = new WorkspaceResourcesService(db, new WorkspaceService(db), {} as never, {} as never, {} as never);
    expect((await platform.resolveNavigation(request, 'personal', { target: `/agents/${lead.id}` })).target).toBe(`/agents/${lead.id}`);
    await expect(platform.resolveNavigation(request, 'personal', { target: `/agents/${child.id}` })).rejects.toThrow('Agent not found');
    const controller = new AgentsController(service, {} as never, {} as never);
    await expect(controller.get(request, child.id)).rejects.toThrow('scope');
    expect(() => controller.update(request, child.id, { parentAgentId: lead.id, name: 'leak' })).toThrow('PATCH /agents/:parentId');
    await expect(controller.delete(request, child.id)).rejects.toThrow('scope');
    await expect(controller.child(request, stranger.id, child.id)).rejects.toThrow('scope');
    expect((await controller.child(request, lead.id, child.id)).id).toBe(child.id);
    expect((await controller.updateChild(request, lead.id, child.id, { name: 'updated' })).name).toBe('updated');
    await controller.deleteChild(request, lead.id, child.id);
    expect((await controller.children(request, lead.id))).toEqual([]);
  });
});
