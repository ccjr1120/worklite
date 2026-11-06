import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { artifacts, agentDraftRevisions as wechatDraftRevisions, agentPublications as wechatPublications, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { WorkspaceService } from '../teams/teams.service';
import { renderArticleImage, validateArticleImageInput, type ArticleImageIssue } from './article-image-renderer';
import { findInlineImageReferences } from './wechat-article-images';
import { articleBodyMarkdown, DraftRevisionError, WechatOfficialAccountService } from './wechat-official-account.service';

type Publication = typeof wechatPublications.$inferSelect;
type Revision = typeof wechatDraftRevisions.$inferSelect;

export type ReviseDraftRequest = {
  requestKey?: unknown;
  title?: unknown;
  imageReplacements?: unknown;
};

const IMAGE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/;
const MAX_TITLE_LENGTH = 64;
const REVISABLE_STATUSES = ['draft_saved', 'confirmation_pending'] as const;
// A rendered illustration records its issue list here; only a clean one may
// replace an image in a draft.
const RENDER_SOURCE = 'wechat_draft_revision';

@Injectable()
export class WechatDraftRevisionService implements OnModuleInit {
  private readonly logger = new Logger(WechatDraftRevisionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly storage: ArtifactStorageService,
    private readonly officialAccount: WechatOfficialAccountService,
  ) {}

  // A revision left applying by a restart was cut off at an unknown point.
  async onModuleInit(): Promise<void> {
    await this.db.update(wechatDraftRevisions)
      .set({ status: 'uncertain', lastError: 'The service restarted while this revision was being applied; check the draft in the WeChat backend and record the result.', updatedAt: new Date() })
      .where(eq(wechatDraftRevisions.status, 'applying'));
  }

  async inspect(runId: string, draftId: string) {
    const publication = await this.findPublication(runId, draftId);
    const revisions = await this.db.select().from(wechatDraftRevisions)
      .where(eq(wechatDraftRevisions.publicationId, publication.id))
      .orderBy(asc(wechatDraftRevisions.createdAt));
    const references = findInlineImageReferences(articleBodyMarkdown(publication.article));
    const imageRows = await this.db.select({ id: artifacts.id, imageKey: artifacts.imageKey, placement: artifacts.placement, content: artifacts.content })
      .from(artifacts)
      .where(and(or(eq(artifacts.runId, publication.runId), sql`case when json_valid(${artifacts.content}) then json_extract(${artifacts.content}, '$.executionId') end = ${publication.runId}`, sql`exists (select 1 from agent_capability_results r where r.execution_id = ${publication.runId} and instr(r.value, ${artifacts.id}) > 0)`), eq(artifacts.workspaceId, publication.workspaceId), eq(artifacts.format, 'image')))
      .orderBy(asc(artifacts.createdAt));
    return {
      runId: publication.runId,
      draftId: publication.draftId,
      publicationStatus: publication.status,
      revisable: (REVISABLE_STATUSES as readonly string[]).includes(publication.status),
      title: publication.title,
      images: references.map((reference, index) => {
        const replaced = savedReplacementFor(revisions, reference.key);
        const original = imageRows.find((row) => row.placement !== 'asset' && row.imageKey === reference.key);
        const artifactId = replaced ?? original?.id ?? null;
        return {
          position: index + 1,
          key: reference.key,
          alt: reference.alt,
          artifactId,
          contentUrl: artifactId ? `/api/artifacts/${encodeURIComponent(artifactId)}/content` : null,
        };
      }),
      revisions: revisions.map(toRevisionView),
      blockingRevision: revisions.find((revision) => revision.status === 'applying' || revision.status === 'uncertain')?.id ?? null,
    };
  }

  async publicationCover(runId: string, draftId: string) {
    const publication = await this.findPublication(runId, draftId);
    const [cover] = await this.db.select().from(artifacts).where(and(eq(artifacts.workspaceId, publication.workspaceId), eq(artifacts.format, 'image'), eq(artifacts.placement, 'asset'),
      or(eq(artifacts.runId, runId), sql`exists (select 1 from agent_capability_results r where r.execution_id = ${runId} and instr(r.value, ${artifacts.id}) > 0)`))).orderBy(asc(artifacts.createdAt)).limit(1);
    if (!cover?.objectKey) throw new BadRequestException('The original cover is unavailable. Provide coverImage before republishing.');
    return { type: 'workflow_image', mediaType: 'image/png', data: [{ b64Json: (await this.storage.read(cover.objectKey)).toString('base64') }] };
  }

  async publicationImages(runId: string, draftId: string, replacements: unknown) {
    const publication = await this.findPublication(runId, draftId);
    const replacementIds = replacements === undefined ? {} : parseReplacements(replacements);
    const rendered = await this.loadReplacementImages(publication, replacementIds);
    const inspected = await this.inspect(runId, draftId);
    const images = [];
    for (const image of inspected.images) {
      let bytes = rendered.get(image.key);
      if (!bytes && image.artifactId) {
        const [artifact] = await this.db.select().from(artifacts).where(and(eq(artifacts.id, image.artifactId), eq(artifacts.workspaceId, publication.workspaceId))).limit(1);
        if (artifact?.objectKey) bytes = await this.storage.read(artifact.objectKey);
      }
      if (!bytes) throw new BadRequestException(`The original image ${image.key} is unavailable. Provide its image data explicitly before republishing.`);
      images.push({ type: 'workflow_image', mediaType: 'image/png', key: image.key, data: [{ b64Json: bytes.toString('base64') }] });
    }
    return images;
  }

  async renderImage(runId: string, draftId: string, body: { key?: unknown; html?: unknown; width?: unknown; height?: unknown }) {
    const publication = await this.findPublication(runId, draftId);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!IMAGE_KEY_PATTERN.test(key)) throw new BadRequestException('key must be 1-64 letters, digits, dots, underscores or hyphens.');
    if (!findInlineImageReferences(articleBodyMarkdown(publication.article)).some((reference) => reference.key === key)) {
      throw new BadRequestException(`The recorded article has no image "${key}".`);
    }
    let input: ReturnType<typeof validateArticleImageInput>;
    try {
      input = validateArticleImageInput(body);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const rendered = await renderArticleImage(input);
    const id = `art_${randomUUID()}`;
    const objectKey = await this.storage.writePng(id, rendered.png);
    try {
      await this.db.insert(artifacts).values({
        id,
        workspaceId: publication.workspaceId,
        runId: null,
        name: `Revised image ${key}`,
        format: 'image',
        size: `${rendered.png.byteLength} B`,
        content: JSON.stringify({ source: RENDER_SOURCE, executionId: publication.runId, key, issues: rendered.issues }),
        objectKey,
        mimeType: 'image/png',
        width: rendered.width,
        height: rendered.height,
        sizeBytes: rendered.png.byteLength,
        imageKey: key,
        placement: 'asset',
      });
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
    return {
      artifactId: id,
      key,
      width: rendered.width,
      height: rendered.height,
      contentUrl: `/api/artifacts/${encodeURIComponent(id)}/content`,
      issues: rendered.issues,
      usable: rendered.issues.length === 0,
    };
  }

  async revise(runId: string, draftId: string, body: ReviseDraftRequest) {
    const requestKey = typeof body.requestKey === 'string' ? body.requestKey.trim() : '';
    if (!REQUEST_KEY_PATTERN.test(requestKey)) throw new BadRequestException('requestKey must be 8-120 letters, digits, dots, colons, underscores or hyphens.');
    const publication = await this.findPublication(runId, draftId);
    const [existing] = await this.db.select().from(wechatDraftRevisions).where(eq(wechatDraftRevisions.requestKey, requestKey)).limit(1);
    if (existing) {
      if (existing.publicationId !== publication.id) throw new ConflictException('requestKey was already used for a different draft.');
      return toRevisionView(existing);
    }
    if (publication.status === 'published') throw new BadRequestException(`Draft ${draftId} has already been published and cannot be revised as a draft. Use a new publication instead.`);
    if (!(REVISABLE_STATUSES as readonly string[]).includes(publication.status)) {
      throw new BadRequestException(`Draft ${draftId} is ${publication.status} and cannot be revised.`);
    }
    const title = parseTitle(body.title);
    const replacements = parseReplacements(body.imageReplacements);
    if (title === undefined && Object.keys(replacements).length === 0) throw new BadRequestException('Provide a title, imageReplacements or both.');
    const keys = new Set(findInlineImageReferences(articleBodyMarkdown(publication.article)).map((reference) => reference.key));
    for (const key of Object.keys(replacements)) {
      if (!keys.has(key)) throw new BadRequestException(`The recorded article has no image "${key}". Available keys: ${[...keys].join(', ') || 'none'}.`);
    }
    const images = await this.loadReplacementImages(publication, replacements);
    const blocking = await this.db.select({ id: wechatDraftRevisions.id, status: wechatDraftRevisions.status }).from(wechatDraftRevisions)
      .where(and(eq(wechatDraftRevisions.publicationId, publication.id), inArray(wechatDraftRevisions.status, ['applying', 'uncertain'])))
      .limit(1);
    if (blocking[0]) {
      throw new ConflictException(blocking[0].status === 'uncertain'
        ? `Revision ${blocking[0].id} has an uncertain result. Check the draft in the WeChat backend and record it with resolve before revising again.`
        : `Revision ${blocking[0].id} is still being applied.`);
    }
    const [revision] = await this.db.insert(wechatDraftRevisions).values({
      id: `wxrev_${randomUUID()}`,
      workspaceId: publication.workspaceId,
      publicationId: publication.id,
      runId: publication.runId,
      draftId: publication.draftId!,
      requestKey,
      title: title ?? null,
      previousTitle: publication.title,
      imageReplacements: replacements,
      status: 'applying',
    }).returning();
    if (!revision) throw new Error('Unable to record the draft revision.');
    void this.apply(revision, publication, title, images);
    return toRevisionView(revision);
  }

  /**
   * Open the draft and run the same checks a revision runs before changing
   * anything, without editing or saving. Use it to confirm the draft still
   * matches the record before asking for a revision.
   */
  async verify(runId: string, draftId: string) {
    const publication = await this.findPublication(runId, draftId);
    try {
      const outcome = await this.officialAccount.reviseExistingDraft({
        revisionId: `verify_${randomUUID()}`,
        publication,
        replacements: new Map(),
        onSaveClicked: async () => { throw new Error('A verification never saves.'); },
        verifyOnly: true,
      });
      return { matches: true, editorTitle: outcome.previousTitle, images: outcome.images, problem: null };
    } catch (error) {
      if (!(error instanceof DraftRevisionError)) throw error;
      return { matches: false, editorTitle: null, images: [], problem: error.message, outcome: error.outcome };
    }
  }

  async getRevision(runId: string, draftId: string, revisionId: string) {
    const publication = await this.findPublication(runId, draftId);
    const [revision] = await this.db.select().from(wechatDraftRevisions)
      .where(and(eq(wechatDraftRevisions.id, revisionId), eq(wechatDraftRevisions.publicationId, publication.id)))
      .limit(1);
    if (!revision) throw new NotFoundException('Draft revision not found.');
    return toRevisionView(revision);
  }

  async resolve(runId: string, draftId: string, revisionId: string, body: { outcome?: unknown; note?: unknown }) {
    const publication = await this.findPublication(runId, draftId);
    if (body.outcome !== 'saved' && body.outcome !== 'not_saved') throw new BadRequestException('outcome must be saved or not_saved.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    if (!note) throw new BadRequestException('note must describe what was checked in the WeChat backend.');
    const [revision] = await this.db.select().from(wechatDraftRevisions)
      .where(and(eq(wechatDraftRevisions.id, revisionId), eq(wechatDraftRevisions.publicationId, publication.id)))
      .limit(1);
    if (!revision) throw new NotFoundException('Draft revision not found.');
    if (revision.status !== 'uncertain') throw new BadRequestException(`Only an uncertain revision can be resolved; this one is ${revision.status}.`);
    const saved = body.outcome === 'saved';
    const detail = { ...revision.detail, resolution: { outcome: body.outcome, note, resolvedAt: new Date().toISOString() } };
    await this.db.transaction((tx) => {
      tx.update(wechatDraftRevisions).set({ status: saved ? 'saved' : 'failed', detail, updatedAt: new Date() }).where(eq(wechatDraftRevisions.id, revision.id)).run();
      if (saved && revision.title) tx.update(wechatPublications).set({ title: revision.title, updatedAt: new Date() }).where(eq(wechatPublications.id, publication.id)).run();
    });
    return this.getRevision(runId, draftId, revisionId);
  }

  private async apply(revision: Revision, publication: Publication, title: string | undefined, images: Map<string, Buffer>): Promise<void> {
    try {
      const outcome = await this.officialAccount.reviseExistingDraft({
        revisionId: revision.id,
        publication,
        title,
        replacements: images,
        onSaveClicked: async () => {
          await this.db.update(wechatDraftRevisions).set({ detail: { saveClickedAt: new Date().toISOString() }, updatedAt: new Date() }).where(eq(wechatDraftRevisions.id, revision.id));
        },
      });
      await this.db.transaction((tx) => {
        tx.update(wechatDraftRevisions).set({
          status: 'saved',
          lastError: null,
          detail: { saveClickedAt: new Date().toISOString(), previousEditorTitle: outcome.previousTitle, bodyWrittenThrough: outcome.bodyWrittenThrough, images: outcome.images },
          updatedAt: new Date(),
        }).where(eq(wechatDraftRevisions.id, revision.id)).run();
        if (title !== undefined) tx.update(wechatPublications).set({ title, updatedAt: new Date() }).where(eq(wechatPublications.id, publication.id)).run();
      });
    } catch (error) {
      const outcome = error instanceof DraftRevisionError ? error.outcome : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`WeChat draft revision ${revision.id} ${outcome}: ${message}`);
      await this.db.update(wechatDraftRevisions).set({ status: outcome, lastError: message, updatedAt: new Date() }).where(eq(wechatDraftRevisions.id, revision.id));
    }
  }

  private async loadReplacementImages(publication: Publication, replacements: Record<string, string>): Promise<Map<string, Buffer>> {
    const images = new Map<string, Buffer>();
    const ids = Object.values(replacements);
    if (ids.length === 0) return images;
    const rows = await this.db.select().from(artifacts).where(and(inArray(artifacts.id, ids), eq(artifacts.workspaceId, publication.workspaceId)));
    for (const [key, artifactId] of Object.entries(replacements)) {
      const row = rows.find((candidate) => candidate.id === artifactId);
      if (!row || (row.runId !== publication.runId && (() => { try { return JSON.parse(row.content).executionId !== publication.runId; } catch { return true; } })())) throw new BadRequestException(`Image Artifact ${artifactId} does not belong to Run ${publication.runId}.`);
      if (row.format !== 'image' || row.mimeType !== 'image/png' || !row.objectKey) throw new BadRequestException(`Artifact ${artifactId} is not a PNG image.`);
      const render = parseRenderRecord(row.content);
      if (!render) throw new BadRequestException(`Artifact ${artifactId} was not produced by render_article_image, so its layout was never checked.`);
      if (render.key !== key) throw new BadRequestException(`Artifact ${artifactId} was rendered for image "${render.key}", not "${key}".`);
      if (render.issues.length > 0) {
        throw new BadRequestException(`Artifact ${artifactId} has layout issues (${render.issues.map((issue) => `${issue.kind}: ${issue.text}`).join('; ')}). Render a corrected image first.`);
      }
      images.set(key, await this.storage.read(row.objectKey));
    }
    return images;
  }

  private async findPublication(runId: string, draftId: string): Promise<Publication> {
    const workspace = await this.workspaces.getWorkspace(undefined);
    if (!runId.trim() || !/^[A-Za-z0-9_-]{1,40}$/.test(draftId)) throw new BadRequestException('runId and a valid draftId are required.');
    const rows = await this.db.select().from(wechatPublications)
      .where(and(eq(wechatPublications.workspaceId, workspace.id), eq(wechatPublications.runId, runId), eq(wechatPublications.draftId, draftId)))
      .limit(2);
    if (rows.length === 0) throw new NotFoundException(`Run ${runId} saved no WeChat draft ${draftId}.`);
    if (rows.length > 1) throw new ConflictException(`Run ${runId} has more than one publication for draft ${draftId}; revise it in the WeChat backend instead.`);
    const publication = rows[0]!;
    return publication;
  }
}

function parseTitle(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException('title must be a string.');
  const title = value.trim();
  if (!title) throw new BadRequestException('title must not be empty.');
  if ([...title].length > MAX_TITLE_LENGTH) throw new BadRequestException(`title must be at most ${MAX_TITLE_LENGTH} characters.`);
  return title;
}

function parseReplacements(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('imageReplacements must map image keys to Artifact ids.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new BadRequestException('imageReplacements accepts at most 20 images.');
  const result: Record<string, string> = {};
  for (const [key, artifactId] of entries) {
    if (!IMAGE_KEY_PATTERN.test(key)) throw new BadRequestException(`Invalid image key "${key}".`);
    if (typeof artifactId !== 'string' || !/^art_[A-Za-z0-9-]{1,80}$/.test(artifactId)) throw new BadRequestException(`imageReplacements.${key} must be an image Artifact id.`);
    result[key] = artifactId;
  }
  return result;
}

function parseRenderRecord(content: string): { key: string; issues: ArticleImageIssue[] } | null {
  try {
    const value = JSON.parse(content) as { source?: unknown; key?: unknown; issues?: unknown };
    if (value.source !== RENDER_SOURCE || typeof value.key !== 'string' || !Array.isArray(value.issues)) return null;
    return { key: value.key, issues: value.issues as ArticleImageIssue[] };
  } catch {
    return null;
  }
}

function savedReplacementFor(revisions: Revision[], key: string): string | undefined {
  for (const revision of [...revisions].reverse()) {
    if (revision.status === 'saved' && revision.imageReplacements[key]) return revision.imageReplacements[key];
  }
  return undefined;
}

function toRevisionView(revision: Revision) {
  return {
    id: revision.id,
    requestKey: revision.requestKey,
    status: revision.status,
    title: revision.title,
    previousTitle: revision.previousTitle,
    imageReplacements: revision.imageReplacements,
    lastError: revision.lastError,
    detail: revision.detail,
    createdAt: revision.createdAt.toISOString(),
    updatedAt: revision.updatedAt.toISOString(),
  };
}
