import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { artifacts, type Database } from '@worklite/db';
import type { ArtifactStorageService } from './artifact-storage.service';
import { readArtifactImageContent } from './artifact-image-content';
import { MAX_LOCAL_FILE_BYTES, safeFileName } from './local-file';

/** Workspace-scoped bytes from registered storage or existing inline text Artifacts; never fetch URLs. */
export async function readArtifactFileContent(db: Database, storage: ArtifactStorageService, workspaceId: string, artifactId: string) {
  const [artifact] = await db.select().from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId))).limit(1);
  if (!artifact) throw new NotFoundException('Artifact content not found');
  if (artifact.format === 'image') return { ...await readArtifactImageContent(db, storage, workspaceId, artifactId), isImage: true };
  const formats = { text: ['txt', 'text/plain; charset=utf-8'], markdown: ['md', 'text/markdown; charset=utf-8'], json: ['json', 'application/json'] } as const;
  const format = formats[artifact.format as keyof typeof formats];
  if (!artifact.objectKey && !format) throw new NotFoundException('Artifact file content not found');
  if ((artifact.sizeBytes ?? 0) > MAX_LOCAL_FILE_BYTES || (!artifact.objectKey && Buffer.byteLength(artifact.content) > MAX_LOCAL_FILE_BYTES)) throw new PayloadTooLargeException('文件超过当前渠道的 20 MB 发送上限。');
  const content = artifact.objectKey ? await storage.read(artifact.objectKey, MAX_LOCAL_FILE_BYTES) : Buffer.from(artifact.content, 'utf8');
  let fileName = safeFileName(artifact.name);
  if (format && !fileName.toLowerCase().endsWith(`.${format[0]}`)) fileName += `.${format[0]}`;
  return { content, mimeType: artifact.objectKey ? 'application/octet-stream' : format![1], sizeBytes: content.length, fileName, isImage: false };
}
