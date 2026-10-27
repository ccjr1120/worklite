import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import type {
  ArtifactDetailView,
  ArtifactListItemView,
  ArtifactListPageView,
  ArtifactListQuery,
  ArtifactView,
} from '@worklite/contracts';
import { artifacts, workflowNodeRuns, workflowRuns, workflows, type Database } from '@worklite/db';
import { findArtifactImagePlaceholders, resolveArtifactInlineImages, type ArtifactImageReference } from './artifact-inline-images';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const SUMMARY_LENGTH = 240;
const UNKNOWN_WORKFLOW = 'Unknown workflow';

function pageNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function pageSizeNumber(value: number | undefined): number {
  return Math.min(MAX_PAGE_SIZE, pageNumber(value, DEFAULT_PAGE_SIZE));
}

function artifactWhere(workspaceId: string, query: ArtifactListQuery): SQL | undefined {
  const conditions = [eq(artifacts.workspaceId, workspaceId)];
  const workflowId = query.workflowId?.trim();
  if (workflowId) conditions.push(eq(artifacts.workflowId, workflowId));
  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const match = or(like(artifacts.name, pattern), like(workflows.name, pattern));
    if (match) conditions.push(match);
  }
  return and(...conditions);
}

export async function listArtifacts(
  db: Database,
  workspaceId: string,
  workspaceSlug: string,
  query: ArtifactListQuery = {},
): Promise<ArtifactListPageView> {
  const pageSize = pageSizeNumber(query.pageSize);
  const where = artifactWhere(workspaceId, query);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(artifacts)
    .leftJoin(workflows, eq(artifacts.workflowId, workflows.id))
    .where(where);
  const total = Number(countRow?.count ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(pageNumber(query.page, 1), totalPages);

  const rows = await db
    .select({
      id: artifacts.id,
      name: artifacts.name,
      format: artifacts.format,
      placement: artifacts.placement,
      workflowId: artifacts.workflowId,
      workflowName: workflows.name,
      runId: artifacts.runId,
      size: artifacts.size,
      mimeType: artifacts.mimeType,
      width: artifacts.width,
      height: artifacts.height,
      sizeBytes: artifacts.sizeBytes,
      objectKey: artifacts.objectKey,
      createdAt: artifacts.createdAt,
      contentLength: sql<number>`length(${artifacts.content})`,
      summary: sql<string>`substr(${artifacts.content}, 1, ${SUMMARY_LENGTH})`,
    })
    .from(artifacts)
    .leftJoin(workflows, eq(artifacts.workflowId, workflows.id))
    .where(where)
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const items: ArtifactListItemView[] = rows.map((row) => ({
    id: row.id,
    workspaceSlug,
    name: row.name,
    format: row.format,
    placement: row.placement,
    workflowId: row.workflowId ?? null,
    workflowName: row.workflowName ?? UNKNOWN_WORKFLOW,
    runId: row.runId ?? '',
    size: row.size,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    contentUrl: row.format === 'image' && row.objectKey ? `/api/artifacts/${encodeURIComponent(row.id)}/content` : null,
    createdAt: row.createdAt?.toISOString() ?? '',
    contentLength: Number(row.contentLength ?? 0),
    summary: row.summary ?? '',
  }));

  return { items, page, pageSize, total, totalPages };
}

export async function getArtifactDetail(
  db: Database,
  workspaceId: string,
  workspaceSlug: string,
  artifactId: string,
): Promise<ArtifactDetailView | null> {
  const [row] = await db
    .select({ artifact: artifacts, workflowName: workflows.name })
    .from(artifacts)
    .leftJoin(workflows, eq(artifacts.workflowId, workflows.id))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;

  const artifact = row.artifact;
  const view: ArtifactView = {
    id: artifact.id,
    workspaceSlug,
    name: artifact.name,
    format: artifact.format,
    placement: artifact.placement,
    workflowId: artifact.workflowId ?? null,
    workflowName: row.workflowName ?? UNKNOWN_WORKFLOW,
    runId: artifact.runId ?? '',
    size: artifact.size,
    mimeType: artifact.mimeType,
    width: artifact.width,
    height: artifact.height,
    sizeBytes: artifact.sizeBytes,
    contentUrl: artifact.format === 'image' && artifact.objectKey ? `/api/artifacts/${encodeURIComponent(artifact.id)}/content` : null,
    createdAt: artifact.createdAt?.toISOString() ?? '',
    content: artifact.content,
  };

  // Only resolve image references when the article actually carries them; the
  // run payload can be large and most artifacts are plain text or JSON.
  const hasPlaceholders = findArtifactImagePlaceholders(artifact.content).length > 0;
  const runData = hasPlaceholders && artifact.runId ? await loadRunRecords(db, workspaceId, artifact.runId) : { records: [], imageArtifacts: [] };
  return {
    ...view,
    contentLength: artifact.content.length,
    inlineImages: hasPlaceholders ? resolveArtifactInlineImages(artifact.content, runData.records, runData.imageArtifacts) : [],
  };
}

async function loadRunRecords(
  db: Database,
  workspaceId: string,
  runId: string,
): Promise<{ records: unknown[]; imageArtifacts: ArtifactImageReference[] }> {
  const [[run], nodeRuns, imageRows] = await Promise.all([
    db
      .select({ result: workflowRuns.result })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, workspaceId)))
      .limit(1),
    db
      .select({ input: workflowNodeRuns.input, output: workflowNodeRuns.output })
      .from(workflowNodeRuns)
      .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.workspaceId, workspaceId))),
    db
      .select({ id: artifacts.id, imageKey: artifacts.imageKey, imagePosition: artifacts.imagePosition, placement: artifacts.placement, objectKey: artifacts.objectKey })
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.workspaceId, workspaceId), eq(artifacts.format, 'image')))
      .orderBy(asc(artifacts.imagePosition), asc(artifacts.createdAt), asc(artifacts.id)),
  ]);
  return {
    records: [run?.result ?? null, ...nodeRuns.flatMap((nodeRun) => [nodeRun.input, nodeRun.output])],
    imageArtifacts: imageRows.filter((row) => row.placement !== 'asset').map((row) => ({
      key: row.imageKey,
      position: row.imagePosition,
      url: row.objectKey ? `/api/artifacts/${encodeURIComponent(row.id)}/content` : null,
    })),
  };
}
