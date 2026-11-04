import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifacts, createDb, initializeDatabase, type Database } from '@worklite/db';
import type { WechatOfficialAccountService } from '../plugins/wechat-official-account.service';
import type { PortkeyGatewayService } from '../model-providers/portkey-gateway.service';
import type { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { AgentCapabilitiesService } from './agent-capabilities.service';
let db: Database;
afterEach(() => db?.$client.close());
async function setup() {
  db = createDb(':memory:'); await initializeDatabase(db);
  const generateImage = vi.fn(async () => ({ type: 'workflow_image', model: 'codex/gpt-image-2', mediaType: 'image/png', data: [{ b64Json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=' }] }));
  const publish = vi.fn<WechatOfficialAccountService['execute']>(async () => ({ output: { status: 'draft_saved' } }));
  const service = new AgentCapabilitiesService(db, { execute: publish } as unknown as WechatOfficialAccountService, { generateImage } as unknown as PortkeyGatewayService, { remove: async () => {}, writePng: async (id: string) => `artifacts/${id}.png` } as unknown as ArtifactStorageService);
  return { service, generateImage, publish };
}
describe('standalone Agent capability tools', () => {
  it('generates an image directly with Agent attribution and no Workflow Run', async () => {
    const { service, generateImage } = await setup();
    const signal = new AbortController().signal;
    const output = await service.execute('workspace_personal', 'execution', 'call', { id: 'illustration', type: 'worklite/image', typeVersion: '1', config: { model: 'codex/gpt-image-2', n: 1, background: 'opaque', quality: 'high', size: '1024x1024' } }, { prompt: 'An illustration' }, signal);
    expect(output).toMatchObject({ data: [{ b64Json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=' }] });
    expect(db.select().from(artifacts).all()).toMatchObject([{ format: 'image', width: 1, height: 1 }]);
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'An illustration', correlation: { surface: 'agent' }, signal }));
    expect(db.$client.prepare('SELECT count(*) AS count FROM workflow_runs').get()).toEqual({ count: 0 });
  });
  it('stores an Agent-selected text artifact without any legacy run or workflow foreign key', async () => {
    const { service } = await setup();
    const output = await service.execute('workspace_personal', 'execution', 'call', { id: 'article', type: 'worklite/artifact', typeVersion: '1', config: { name: 'Article', format: 'markdown' } }, { data: '# Article' }, new AbortController().signal);
    expect(output).toMatchObject({ format: 'markdown', name: 'Article' });
    expect(db.select().from(artifacts).all()[0]).toMatchObject({ workflowId: null, runId: null, content: '# Article' });
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });
  it('lets an Agent choose draft or publish directly without a workflow or saved mode restriction', async () => {
    const { service, publish } = await setup();
    const capability = { id: 'wechat', type: 'wechat-official-account/publish', typeVersion: '2', config: { accountId: 'personal', mode: 'draft' } };
    await service.execute('workspace_personal', 'execution', 'call', capability, { operation: 'publish', mode: 'publish', article: '# Updated article' }, new AbortController().signal);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ config: { mode: 'publish' }, input: { article: '# Updated article' }, context: { workflowRunId: 'execution', nodeRunId: 'call' } });
    expect(await service.execute('workspace_personal', 'execution', 'list', capability, { operation: 'list' }, new AbortController().signal)).toEqual([]);
    await expect(service.execute('workspace_personal', 'execution', 'inspect', capability, { operation: 'inspect', runId: 'missing', draftId: 'missing' }, new AbortController().signal)).rejects.toThrow('recorded Agent article');
  });
  it('publishes through an individual operation and rejects graph-control capabilities', async () => {
    const { service, publish } = await setup();
    await service.execute('workspace_personal', 'execution', 'operation', { id: 'publish', type: 'wechat-official-account/publish', typeVersion: '2', config: {} }, { article: '# Article' }, new AbortController().signal);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ context: { workflowRunId: 'execution', nodeRunId: 'operation' } });
    await expect(service.execute('workspace_personal', 'execution', 'call', { id: 'map', type: 'worklite/map', typeVersion: '1', config: {} }, {}, new AbortController().signal)).rejects.toThrow('Control-flow');
  });
});
