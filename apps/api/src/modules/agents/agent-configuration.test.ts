import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { skills, agents, createDb, initializeDatabase, type Database } from '@worklite/db';
import { AgentsService } from './agents.service';
import { WorkspaceService } from '../teams/teams.service';
import type { WorkspaceResourcesService } from '../teams/team-resources.service';
let db: Database;
afterEach(() => { db?.$client.close(); vi.unstubAllGlobals(); });
async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  return new AgentsService(db, new WorkspaceService(db), { reconcileWorkspaceSkills: async () => {} } as unknown as WorkspaceResourcesService);
}
const input = { name: 'Lead', responsibility: 'Coordinate tasks', systemPrompt: 'Choose the appropriate sub-Agents', providerId: null, model: 'provider/model', skillIds: [], mcpServerIds: [], collaboration: { subAgentIds: [], capabilities: [], publicModels: ['provider/model'] } };
describe('unified Agent configuration', () => {
  it('saves private tools on the Agent without creating Skills and validates handlers', async () => {
    const service = await setup(); const request = {} as Request;
    const before = db.select().from(skills).all().length;
    const privateTools = [{ name: 'save_article', description: 'Save the article', inputSchema: { type: 'object', properties: { input: {} } }, handler: { kind: 'capability' as const, capabilityId: 'article' } }];
    const collaboration = { ...input.collaboration, capabilities: [{ id: 'article', type: 'worklite/artifact', typeVersion: '1', config: { name: 'Article' } }], privateTools };
    const agent = await service.create(request, 'personal', { ...input, collaboration });
    expect((await service.get(request, 'personal', agent.id)).collaboration?.privateTools).toEqual(privateTools);
    expect(db.select().from(skills).all()).toHaveLength(before);
    await expect(service.update(request, 'personal', agent.id, { collaboration: { ...collaboration, capabilities: [] } })).rejects.toThrow('must belong');
    await expect(service.update(request, 'personal', agent.id, { collaboration: { ...collaboration, privateTools: [...privateTools, ...privateTools] } })).rejects.toThrow('duplicated');
    await expect(service.update(request, 'personal', agent.id, { runtime: { kind: 'codex', projectDirectory: '' } })).rejects.toThrow('native');
  });

  it('atomically creates and assigns an engine-backed sub-Agent to its native parent', async () => {
    const service = await setup(); const request = {} as Request;
    const lead = await service.create(request, 'personal', input);
    const child = await service.create(request, 'personal', { ...input, parentAgentId: lead.id, name: 'Implementer', runtime: { kind: 'codex', projectDirectory: '' } });
    expect(child).not.toHaveProperty('version');
    expect(child).not.toHaveProperty('latestVersionId');
    expect(child).not.toHaveProperty('latestVersion');
    expect(child.runtime).toEqual({ kind: 'codex', projectDirectory: '' });
    expect((await service.get(request, 'personal', lead.id)).collaboration?.subAgentIds).toEqual([child.id]);
  });
  it('creates no orphan Agent when a parent is missing or an assignment would create a cycle', async () => {
    const service = await setup(); const request = {} as Request;
    const lead = await service.create(request, 'personal', input);
    await expect(service.create(request, 'personal', { ...input, parentAgentId: 'missing' })).rejects.toThrow('parent');
    await expect(service.create(request, 'personal', { ...input, parentAgentId: lead.id, collaboration: { ...input.collaboration, subAgentIds: [lead.id] } })).rejects.toThrow('cycles');
    expect(db.select().from(agents).all().filter((agent) => agent.kind === 'custom')).toHaveLength(1);
  });
});
