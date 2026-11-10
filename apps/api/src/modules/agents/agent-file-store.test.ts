import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { CHAT_AGENT_ID } from '@worklite/contracts';
import { agents, agentSkills, agentExecutions, skills, skillFiles, createDb, initializeDatabase, type Database } from '@worklite/db';
import type { Request } from 'express';
import type { WorkspaceResourcesService } from '../teams/team-resources.service';
import { WorkspaceService } from '../teams/teams.service';
import { AgentCollaborationService } from './agent-collaboration.service';
import type { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';
import type { AgentCapabilitiesService } from './agent-capabilities.service';
import { initializeAgentFiles } from './agent-file-store';
import { AgentsService } from './agents.service';
import { parse, stringify } from 'yaml';

let db: Database;
let directory: string;
afterEach(() => { db?.$client.close(); if (directory) rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });
const request = {} as Request;
const workspace = 'workspace_personal';
const input = { name: 'New Agent', responsibility: 'Work', systemPrompt: 'Do work', providerId: null, model: 'provider/model', skillIds: [], mcpServerIds: [], collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } };
async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  directory = mkdtempSync(join(tmpdir(), 'worklite-agent-files-'));
  db.insert(agents).values([
    { id: 'lead', workspaceId: workspace, name: 'qcoder', responsibility: 'Coordinate', model: 'provider/model', systemPrompt: 'Lead prompt\n', collaboration: { subAgentIds: ['child'], capabilities: [], publicModels: ['provider/model'], privateTools: [{ name: 'save_file', description: 'Save', inputSchema: { type: 'object' }, handler: { kind: 'command', command: 'echo saved', workingDirectory: '/tmp' } }] } },
    { id: 'child', workspaceId: workspace, name: 'im-claude', responsibility: 'Implement', model: 'provider/model', systemPrompt: 'Child prompt', runtime: { kind: 'claude', projectDirectory: '' }, collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } },
  ]).run();
  db.insert(skills).values({ id: 'shared', workspaceId: workspace, name: 'Code Skill', instructions: '# Code Skill\nUse evidence.', validation: 'valid' }).run();
  db.insert(skillFiles).values({ skillId: 'shared', path: 'scripts/check.sh', content: '#!/bin/sh\necho evidence' }).run();
  db.insert(agentSkills).values({ agentId: 'lead', skillId: 'shared' }).run();
  db.insert(agentExecutions).values({ id: 'saved-execution', workspaceId: workspace, agentId: 'lead', status: 'completed', displayMessages: [{ id: 'message', role: 'user', content: 'Original task', createdAt: new Date().toISOString() }] }).run();
  const root = join(directory, 'agents');
  const catalog = initializeAgentFiles(db, root);
  const resources = { reconcileWorkspaceSkills: async () => {}, workflowMcpRuntimes: async () => [], resolveSkillIds: async (_ws: string, ids: string[]) => ids } as unknown as WorkspaceResourcesService;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  const service = new AgentsService(db, new WorkspaceService(db), resources);
  return { catalog, root, resources, service };
}

describe('file-owned Agent catalog', () => {
  it('loads the wechat-article capability shapes through API writes and file reads', async () => {
    const { catalog, service } = await setup();
    const capabilities = [
      { id: 'wn_0eee172b-6f28-494f-9838-17772c6438d0/wn_map_render_9a4b8e2d', type: 'worklite/canvas-render', typeVersion: '1', config: {} },
      { id: 'image', type: 'worklite/image', typeVersion: '1', config: {} },
      { id: 'compose', type: 'worklite/compose-article', typeVersion: '1', config: {} },
      { id: 'publish', type: 'wechat-official-account/publish', typeVersion: '2', config: {} },
      ...['article', 'images', 'result'].map((id) => ({ id, type: 'worklite/artifact', typeVersion: '1', config: {} })),
    ];
    const collaboration = { ...input.collaboration, subAgentIds: ['child'], capabilities };
    expect((await service.update(request, 'personal', 'lead', { collaboration })).collaboration?.capabilities).toEqual(capabilities);
    catalog.refresh(workspace);
    expect((await service.list(request, 'personal')).find((agent) => agent.id === 'lead')?.collaboration?.capabilities).toEqual(capabilities);
    expect((await service.get(request, 'personal', CHAT_AGENT_ID)).id).toBe(CHAT_AGENT_ID);
    await expect(service.update(request, 'personal', 'lead', { collaboration: { ...collaboration, capabilities: [...capabilities, capabilities[0]!] } }))
      .rejects.toThrow('Duplicate Agent capability id "wn_0eee172b-6f28-494f-9838-17772c6438d0/wn_map_render_9a4b8e2d" in Agent "lead" collaboration');
  });

  it.each(['duplicate', 'config'] as const)('isolates a capability %s failure from Chat and reports its exact source', async (failure) => {
    const { catalog, root, service } = await setup();
    const healthy = await service.create(request, 'personal', { ...input, name: 'Healthy' });
    const path = join(root, 'qcoder/AGENT.md');
    const original = readFileSync(path, 'utf8');
    const [, frontmatter, body] = original.split('---');
    const config = parse(frontmatter!);
    const capability = { id: 'render/map', type: 'worklite/artifact', typeVersion: '1', config: {} };
    config.collaboration.capabilities = failure === 'duplicate' ? [capability, { ...capability, config: {} }] : [{ ...capability, config: null }];
    writeFileSync(path, `---\n${stringify(config)}---${body}`);
    expect(() => catalog.refresh(workspace, root, false)).toThrow(path);
    expect(() => catalog.refresh(workspace, root, false)).toThrow(failure === 'duplicate' ? 'Duplicate Agent capability id "render/map"' : 'config must be an object');
    expect((await service.get(request, 'personal', CHAT_AGENT_ID)).id).toBe(CHAT_AGENT_ID);
    expect((await service.list(request, 'personal')).map((agent) => agent.id)).toEqual([healthy.id]);
    expect((await service.update(request, 'personal', CHAT_AGENT_ID, { extensionPrompt: 'Still editable' })).chatConfiguration?.extensionPrompt).toBe('Still editable');
    writeFileSync(path, original);
    expect((await service.list(request, 'personal')).map((agent) => agent.id)).toContain('lead');
  });

  it('migrates the complete private tree once, copies Skills and tools, and preserves executions and ids', async () => {
    const { root, catalog } = await setup();
    expect(readdirSync(root)).toEqual(['qcoder']);
    expect(readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8')).toContain('id: lead');
    expect(readFileSync(join(root, 'qcoder/subagents/im-claude/AGENT.md'), 'utf8')).toContain('id: child');
    expect(readFileSync(join(root, 'qcoder/tools/save_file.yaml'), 'utf8')).toContain('echo saved');
    const copied = catalog.get('lead')!.skills[0]!;
    expect(copied.id).toBe('shared');
    expect(copied.files).toContainEqual({ path: 'scripts/check.sh', content: '#!/bin/sh\necho evidence' });
    const before = readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8');
    initializeAgentFiles(db, root);
    expect(readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8')).toBe(before);
    expect(db.select().from(agentExecutions).get()!.id).toBe('saved-execution');
  });

  it('loads edits from files and does not resurrect removed children or rewrite unchanged timestamps', async () => {
    const { root, catalog, service } = await setup();
    const path = join(root, 'qcoder/AGENT.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('Lead prompt\n', 'Edited directly\n'));
    expect((await service.get(request, 'personal', 'lead')).systemPrompt).toBe('Edited directly\n');
    const timestamp = db.select().from(agents).where(eq(agents.id, 'lead')).get()!.updatedAt.getTime();
    catalog.refresh(workspace);
    expect(db.select().from(agents).where(eq(agents.id, 'lead')).get()!.updatedAt.getTime()).toBe(timestamp);
    rmSync(join(root, 'qcoder/subagents/im-claude'), { recursive: true });
    initializeAgentFiles(db, root);
    expect((await service.get(request, 'personal', 'lead')).collaboration!.subAgentIds).toEqual([]);
    expect(await service.list(request, 'personal')).toHaveLength(1);
    expect(db.select().from(agents).where(eq(agents.id, 'child')).get()).toBeDefined();
    await expect(service.get(request, 'personal', 'child')).rejects.toThrow('scope');
  });

  it('keeps child access inside the owner and persists configuration edits and new private children to files', async () => {
    const { root, service } = await setup();
    expect((await service.list(request, 'personal')).map((item) => item.id)).toEqual(['lead']);
    await expect(service.get(request, 'personal', 'child')).rejects.toThrow('scope');
    await expect(service.update(request, 'personal', 'child', { name: 'Wrong scope' })).rejects.toThrow('scope');
    expect((await service.get(request, 'personal', 'lead')).subAgents![0]!.name).toBe('im-claude');
    const child = await service.create(request, 'personal', { ...input, name: 'im-codex', parentAgentId: 'lead', runtime: { kind: 'codex', projectDirectory: '' } });
    expect(readFileSync(join(root, 'qcoder/subagents/im-codex/AGENT.md'), 'utf8')).toContain(child.id);
    await service.update(request, 'personal', 'child', { parentAgentId: 'lead', systemPrompt: 'Updated private prompt' });
    expect(readFileSync(join(root, 'qcoder/subagents/im-claude/AGENT.md'), 'utf8')).toContain('Updated private prompt');
    await service.delete(request, 'personal', child.id, 'lead');
    expect(readdirSync(join(root, 'qcoder/subagents'))).toEqual(['im-claude']);
    expect(db.select().from(agentExecutions).get()!.id).toBe('saved-execution');
  });

  it('loads private Skill edits into execution snapshots independently of shared catalog changes', async () => {
    const { catalog, root, resources } = await setup();
    const skillDirectory = readdirSync(join(root, 'qcoder/skills'))[0]!;
    const skillPath = join(root, 'qcoder/skills', skillDirectory, 'SKILL.md');
    writeFileSync(skillPath, readFileSync(skillPath, 'utf8') + '\nPrivate instructions');
    db.update(skills).set({ instructions: 'Unrelated global change', validation: 'invalid' }).where(eq(skills.id, 'shared')).run();
    const execute = vi.fn<IsolatedAgentInvocationService['execute']>(async (invocation) => {
      expect(invocation.skills).toHaveLength(1);
      expect(invocation.skills![0]!.instructions).toContain('Private instructions');
      expect(invocation.managedTools!.some((tool) => tool.name === 'save_file')).toBe(true);
      return 'Result';
    });
    const collaboration = new AgentCollaborationService(db, resources, { execute } as unknown as IsolatedAgentInvocationService, {} as AgentCapabilitiesService);
    expect(await collaboration.run(workspace, 'saved-execution', 'lead', 'Task', new AbortController().signal)).toBe('Result');
    expect(catalog.get('lead')!.skills[0]!.instructions).toContain('Private instructions');
  });

  it('discovers newly authored private Skills and command Tools on the next invocation without API updates', async () => {
    const { root, resources, service } = await setup();
    const toolDirectory = join(root, 'qcoder/tools');
    const skillDirectory = join(root, 'qcoder/skills/project-notes');
    mkdirSync(skillDirectory);
    writeFileSync(join(skillDirectory, 'SKILL.md'), '---\nname: Project Notes\n---\nUse the project_notes tool to read notes.');
    writeFileSync(join(toolDirectory, 'notes.mjs'), 'console.log(JSON.parse(Buffer.from(process.env.WORKLITE_TOOL_INPUT_BASE64, "base64").toString()));');
    writeFileSync(join(toolDirectory, 'project-notes.yaml'), `name: project_notes
 description: Read project notes
 inputSchema:
   type: object
   properties:
     project: { type: string }
 handler:
   kind: command
   command: node notes.mjs
   workingDirectory: ${JSON.stringify(toolDirectory)}
`.replace(/^ /gm, ''));
    const view = await service.get(request, 'personal', 'lead');
    expect(view.skills.some((skill) => skill.name === 'Project Notes')).toBe(true);
    expect(view.collaboration?.privateTools).toContainEqual(expect.objectContaining({ name: 'project_notes', handler: { kind: 'command', command: 'node notes.mjs', workingDirectory: toolDirectory } }));
    const execute = vi.fn<IsolatedAgentInvocationService['execute']>(async (invocation) => {
      expect(invocation.skills!.some((skill) => skill.name === 'Project Notes')).toBe(true);
      expect(invocation.managedTools!.some((tool) => tool.name === 'project_notes')).toBe(true);
      return 'Loaded';
    });
    const collaboration = new AgentCollaborationService(db, resources, { execute } as unknown as IsolatedAgentInvocationService, {} as AgentCapabilitiesService);
    expect(await collaboration.run(workspace, 'saved-execution', 'lead', 'Read notes', new AbortController().signal)).toBe('Loaded');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retains private execution history on API deletion and never revives a deleted catalog after restart', async () => {
    const { root, service } = await setup();
    db.insert(agentExecutions).values({ id: 'child-history', workspaceId: workspace, agentId: 'child', status: 'completed' }).run();
    await service.delete(request, 'personal', 'child', 'lead');
    expect(db.select().from(agentExecutions).where(eq(agentExecutions.id, 'child-history')).get()).toBeDefined();
    expect(readdirSync(join(root, 'qcoder/subagents'))).toEqual([]);
    rmSync(root, { recursive: true });
    initializeAgentFiles(db, root);
    expect(await service.list(request, 'personal')).toEqual([]);
    expect(db.select().from(agentExecutions).all()).toHaveLength(2);
  });

  it('rejects invalid or duplicate files before changing the database projection', async () => {
    const { catalog, root } = await setup();
    const previous = db.select().from(agents).where(eq(agents.id, 'lead')).get()!.systemPrompt;
    const duplicate = join(root, 'duplicate'); mkdirSync(duplicate);
    writeFileSync(join(duplicate, 'AGENT.md'), readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8'));
    expect(() => catalog.refresh(workspace, root, false)).toThrow('Duplicate Agent id');
    expect(db.select().from(agents).where(eq(agents.id, 'lead')).get()!.systemPrompt).toBe(previous);
    rmSync(duplicate, { recursive: true });
    symlinkSync(join(root, 'qcoder'), duplicate);
    expect(() => catalog.refresh(workspace, root, false)).toThrow('real directories');
  });

  it('keeps system configuration readable and writable when a custom capability is unsupported', async () => {
    const { root, service, catalog } = await setup();
    const path = join(root, 'qcoder/AGENT.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('capabilities: []', 'capabilities:\n    - id: future\n      type: worklite/future-capability\n      typeVersion: "1"\n      config: {}'));
    expect(() => catalog.refresh(workspace, root, false)).toThrow(`Unsupported Agent capability worklite/future-capability@1 in ${path}`);
    expect((await service.get(request, 'personal', CHAT_AGENT_ID)).id).toBe(CHAT_AGENT_ID);
    const updated = await service.update(request, 'personal', CHAT_AGENT_ID, { extensionPrompt: 'Still editable' });
    expect(updated.chatConfiguration?.extensionPrompt).toBe('Still editable');
    await expect(service.get(request, 'personal', 'lead')).rejects.toThrow('scope');
  });

  it('isolates malformed child packages, retains history, and recovers after repair', async () => {
    const { root, catalog, service, resources } = await setup();
    const healthy = await service.create(request, 'personal', { ...input, name: 'Healthy' });
    const path = join(root, 'qcoder/subagents/im-claude/AGENT.md');
    const original = readFileSync(path, 'utf8');
    const broken = original.replace('responsibility: Implement', 'responsibility: "Implement"\n  leftover text"');
    writeFileSync(path, broken);
    expect((await service.list(request, 'personal')).map((item) => item.id)).toEqual([healthy.id]);
    expect((await service.get(request, 'personal', healthy.id)).name).toBe('Healthy');
    expect(catalog.get('lead')).toBeUndefined();
    expect(catalog.get('child')).toBeUndefined();
    const execute = vi.fn<IsolatedAgentInvocationService['execute']>(async () => 'Healthy result');
    const collaboration = new AgentCollaborationService(db, resources, { execute } as unknown as IsolatedAgentInvocationService, {} as AgentCapabilitiesService);
    expect(await collaboration.run(workspace, 'saved-execution', healthy.id, 'Task', new AbortController().signal)).toBe('Healthy result');
    await expect(collaboration.run(workspace, 'saved-execution', 'lead', 'Task', new AbortController().signal)).rejects.toThrow('available');
    expect(execute).toHaveBeenCalledOnce();
    expect(db.select().from(agentExecutions).get()!.id).toBe('saved-execution');
    // Strict publishing must not discard the broken package or its supporting files.
    await expect(service.update(request, 'personal', healthy.id, { name: 'Changed' })).rejects.toThrow('Invalid YAML');
    expect(readFileSync(path, 'utf8')).toBe(broken);
    expect(() => initializeAgentFiles(db, root)).not.toThrow();
    writeFileSync(path, original);
    expect((await service.list(request, 'personal')).map((item) => item.id).sort()).toEqual([healthy.id, 'lead'].sort());
    expect((await service.get(request, 'personal', 'lead')).subAgents![0]!.id).toBe('child');
  });

  it('isolates conflicting identities and invalid tools without disabling healthy packages', async () => {
    const { root, catalog, service } = await setup();
    const healthy = await service.create(request, 'personal', { ...input, name: 'Healthy' });
    const duplicate = join(root, 'duplicate'); mkdirSync(duplicate);
    writeFileSync(join(duplicate, 'AGENT.md'), readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8'));
    expect(catalog.refresh(workspace).map((entry) => entry.agent.id)).toEqual([healthy.id]);
    rmSync(duplicate, { recursive: true });
    writeFileSync(join(root, 'qcoder/tools/save_file.yaml'), 'name: [broken');
    expect(catalog.refresh(workspace).map((entry) => entry.agent.id)).toEqual([healthy.id]);
  });

  it('rolls back invalid API changes and preserves package files when renaming the owner', async () => {
    const { root, service } = await setup();
    const before = readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8');
    await expect(service.update(request, 'personal', 'lead', { collaboration: { ...input.collaboration, subAgentIds: ['missing'] } })).rejects.toThrow('workspace');
    expect(readFileSync(join(root, 'qcoder/AGENT.md'), 'utf8')).toBe(before);
    await service.update(request, 'personal', 'lead', { name: 'Renamed', skillIds: ['shared'] });
    expect(readdirSync(root)).toEqual(['Renamed']);
    expect(readFileSync(join(root, 'Renamed/subagents/im-claude/AGENT.md'), 'utf8')).toContain('Child prompt');
    expect((await service.get(request, 'personal', 'lead')).skills.map((skill) => skill.id)).toEqual(['shared']);
  });
});

it('round-trips use-site model parameters through Agent files without changing another Agent or Chat', async () => {
  const { catalog, service } = await setup();
  const modelParameters = { reasoningEffort: 'high' as const, serviceTier: 'fast' as const };
  const child = await service.update(request, 'personal', 'child', { parentAgentId: 'lead', modelParameters });
  expect(child.modelParameters).toEqual(modelParameters);
  const byModel = { 'provider/model': { reasoningEffort: 'low' as const, requestBody: { temperature: 0.2 } } };
  await service.update(request, 'personal', 'lead', { collaboration: { ...input.collaboration, subAgentIds: ['child'], modelParameters: byModel } });
  catalog.refresh(workspace);
  expect(catalog.get('child')?.agent.modelParameters).toEqual(modelParameters);
  expect(catalog.get('lead')?.agent.modelParameters).toEqual({});
  expect(catalog.get('lead')?.agent.collaboration?.modelParameters).toEqual(byModel);
  expect((await service.get(request, 'personal', CHAT_AGENT_ID)).modelParameters).toEqual({});
  await service.update(request, 'personal', CHAT_AGENT_ID, { modelParameters });
  expect((await service.get(request, 'personal', CHAT_AGENT_ID)).modelParameters).toEqual(modelParameters);
  expect(catalog.get('lead')?.agent.modelParameters).toEqual({});
});

it('refreshes a parameter-only AGENT.md edit into the runtime index', async () => {
  const { catalog, root, service } = await setup();
  const path = join(root, 'qcoder/subagents/im-claude/AGENT.md');
  const [, frontmatter, body] = readFileSync(path, 'utf8').split('---');
  const config = parse(frontmatter!);
  config.modelParameters = { reasoningEffort: 'high', serviceTier: 'fast' };
  writeFileSync(path, `---\n${stringify(config)}---${body}`);
  catalog.refresh(workspace);
  expect((await service.get(request, 'personal', 'child', 'lead')).modelParameters).toEqual(config.modelParameters);
});
