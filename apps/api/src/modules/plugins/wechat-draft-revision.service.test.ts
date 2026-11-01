import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifacts, createDb, initializeDatabase, wechatDraftRevisions, wechatPublications, type Database } from '@worklite/db';
import { eq } from 'drizzle-orm';
import type { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import type { WorkspaceService } from '../teams/teams.service';
import { WechatDraftRevisionService } from './wechat-draft-revision.service';
import { DraftRevisionError, type WechatOfficialAccountService } from './wechat-official-account.service';

const WORKSPACE_ID = 'workspace_personal';
const RUN_ID = 'run_target';
const DRAFT_ID = '100000489';
const ARTICLE = '# 旧标题\n\n第一段。\n\n![记忆](worklite-image:fig-a)\n\n第二段。\n\n![参数](worklite-image:fig-b)\n';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let db: Database;
let revise: ReturnType<typeof vi.fn>;

function service(): WechatDraftRevisionService {
  const workspaces = { getWorkspace: async () => ({ id: WORKSPACE_ID, slug: 'personal', name: 'Personal' }) } as unknown as WorkspaceService;
  const storage = { read: async () => PNG, writePng: async (id: string) => `artifacts/${id}.png`, remove: async () => undefined } as unknown as ArtifactStorageService;
  return new WechatDraftRevisionService(db, workspaces, storage, { reviseExistingDraft: revise } as unknown as WechatOfficialAccountService);
}

function insertPublication(values: Partial<typeof wechatPublications.$inferInsert> = {}): void {
  db.insert(wechatPublications).values({
    id: `wechat_pub_${values.runId ?? RUN_ID}_${values.draftId ?? DRAFT_ID}`,
    workspaceId: WORKSPACE_ID,
    accountId: 'wechat_official_account_personal',
    runId: RUN_ID,
    nodeRunId: 'nrun_target',
    idempotencyKey: `key_${values.runId ?? RUN_ID}_${values.draftId ?? DRAFT_ID}`,
    mode: 'draft',
    status: 'draft_saved',
    title: '旧标题',
    article: ARTICLE,
    draftId: DRAFT_ID,
    ...values,
  }).run();
}

function insertImage(id: string, values: Partial<typeof artifacts.$inferInsert> = {}): void {
  db.insert(artifacts).values({
    id,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    name: id,
    format: 'image',
    mimeType: 'image/png',
    objectKey: `artifacts/${id}.png`,
    imageKey: 'fig-a',
    placement: 'asset',
    content: JSON.stringify({ source: 'wechat_draft_revision', key: 'fig-a', issues: [] }),
    ...values,
  }).run();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  db = createDb(':memory:');
  await initializeDatabase(db);
  // Publications reference Workflow Runs; the revision rules under test do not.
  db.$client.pragma('foreign_keys = OFF');
  revise = vi.fn(async () => ({ draftId: DRAFT_ID, previousTitle: '旧标题', title: '新标题', images: [], bodyWrittenThrough: 'editor_api' }));
});

afterEach(() => {
  db.$client.close();
});

describe('WechatDraftRevisionService target checks', () => {
  it('rejects a draft id the Run did not save before opening a browser', async () => {
    insertPublication();
    await expect(service().revise(RUN_ID, '100000999', { requestKey: 'request-0001', title: '新标题' })).rejects.toThrow('saved no WeChat draft 100000999');
    await expect(service().revise('run_other', DRAFT_ID, { requestKey: 'request-0001', title: '新标题' })).rejects.toThrow('saved no WeChat draft');
    expect(revise).not.toHaveBeenCalled();
  });

  it('rejects a published draft', async () => {
    insertPublication({ status: 'published' });
    await expect(service().revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', title: '新标题' })).rejects.toThrow('already been published');
    expect(revise).not.toHaveBeenCalled();
  });

  it('rejects an unknown image key, an image from another Run and an image with layout issues', async () => {
    insertPublication();
    insertImage('art_other-run', { runId: 'run_other' });
    insertImage('art_with-issues', { content: JSON.stringify({ source: 'wechat_draft_revision', key: 'fig-a', issues: [{ kind: 'overlap', text: 'A / B', detail: '' }] }) });
    insertImage('art_unchecked', { content: '' });
    const revisions = service();
    await expect(revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', imageReplacements: { 'fig-z': 'art_x' } })).rejects.toThrow('has no image "fig-z"');
    await expect(revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0002', imageReplacements: { 'fig-a': 'art_other-run' } })).rejects.toThrow('does not belong to Run');
    await expect(revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0003', imageReplacements: { 'fig-a': 'art_with-issues' } })).rejects.toThrow('has layout issues');
    await expect(revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0004', imageReplacements: { 'fig-a': 'art_unchecked' } })).rejects.toThrow('layout was never checked');
    expect(revise).not.toHaveBeenCalled();
  });

  it('lists the article image keys in body order', async () => {
    insertPublication();
    const view = await service().inspect(RUN_ID, DRAFT_ID);
    expect(view.images.map((image) => image.key)).toEqual(['fig-a', 'fig-b']);
    expect(view.revisable).toBe(true);
  });
});

describe('WechatDraftRevisionService revisions', () => {
  it('saves a title and image revision and records the new title', async () => {
    insertPublication();
    insertImage('art_clean');
    const created = await service().revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', title: '同样是大模型，有什么区别？', imageReplacements: { 'fig-a': 'art_clean' } });
    expect(created.status).toBe('applying');
    await settle();
    expect(revise).toHaveBeenCalledTimes(1);
    const call = revise.mock.calls[0]![0] as { title: string; replacements: Map<string, Buffer> };
    expect(call.title).toBe('同样是大模型，有什么区别？');
    expect([...call.replacements.keys()]).toEqual(['fig-a']);
    const [revision] = db.select().from(wechatDraftRevisions).all();
    expect(revision?.status).toBe('saved');
    const [publication] = db.select().from(wechatPublications).all();
    expect(publication?.title).toBe('同样是大模型，有什么区别？');
  });

  it('returns the recorded revision for a repeated requestKey without operating the account again', async () => {
    insertPublication();
    const revisions = service();
    const first = await revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', title: '新标题' });
    await settle();
    const second = await revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', title: '新标题' });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('saved');
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it('blocks further revisions after an uncertain result until it is resolved', async () => {
    insertPublication();
    revise.mockRejectedValueOnce(new DraftRevisionError('uncertain', 'Save was clicked but its result is unknown: timeout'));
    const revisions = service();
    const first = await revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', title: '新标题' });
    await settle();
    expect((await revisions.getRevision(RUN_ID, DRAFT_ID, first.id)).status).toBe('uncertain');
    await expect(revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0002', title: '另一个标题' })).rejects.toThrow('uncertain result');
    expect(revise).toHaveBeenCalledTimes(1);

    await expect(revisions.resolve(RUN_ID, DRAFT_ID, first.id, { outcome: 'saved' })).rejects.toThrow('note must describe');
    const resolved = await revisions.resolve(RUN_ID, DRAFT_ID, first.id, { outcome: 'saved', note: '后台草稿标题已是新标题' });
    expect(resolved.status).toBe('saved');
    expect(db.select().from(wechatPublications).where(eq(wechatPublications.draftId, DRAFT_ID)).all()[0]?.title).toBe('新标题');

    await revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0002', title: '另一个标题' });
    await settle();
    expect(revise).toHaveBeenCalledTimes(2);
  });

  it('records a failure that stopped before save without blocking the draft', async () => {
    insertPublication();
    revise.mockRejectedValueOnce(new DraftRevisionError('failed', 'The draft body no longer matches the recorded article.'));
    const revisions = service();
    const first = await revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0001', title: '新标题' });
    await settle();
    const failed = await revisions.getRevision(RUN_ID, DRAFT_ID, first.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('no longer matches');
    await expect(revisions.resolve(RUN_ID, DRAFT_ID, first.id, { outcome: 'saved', note: 'x' })).rejects.toThrow('Only an uncertain revision');
    await revisions.revise(RUN_ID, DRAFT_ID, { requestKey: 'request-0002', title: '新标题' });
    expect(revise).toHaveBeenCalledTimes(2);
  });

  it('marks a revision left applying by a restart as uncertain', async () => {
    insertPublication();
    db.insert(wechatDraftRevisions).values({ id: 'wxrev_stale', workspaceId: WORKSPACE_ID, publicationId: `wechat_pub_${RUN_ID}_${DRAFT_ID}`, runId: RUN_ID, draftId: DRAFT_ID, requestKey: 'request-stale', previousTitle: '旧标题', status: 'applying' }).run();
    await service().onModuleInit();
    expect(db.select().from(wechatDraftRevisions).all()[0]?.status).toBe('uncertain');
  });
});
