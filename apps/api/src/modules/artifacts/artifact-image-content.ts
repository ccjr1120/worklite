import { NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { artifacts, type Database } from '@worklite/db';
import { MAX_LOCAL_FILE_BYTES } from './local-file';
import type { ArtifactStorageService } from './artifact-storage.service';

/** Shared by the Web content route and channel delivery; never resolve a supplied URL over HTTP. */
export async function readArtifactImageContent(db: Database, storage: ArtifactStorageService, workspaceId: string, artifactId: string): Promise<{ content: Buffer; mimeType: string; sizeBytes: number; fileName: string }> {
  const [artifact] = await db.select({ id: artifacts.id, format: artifacts.format, objectKey: artifacts.objectKey, mimeType: artifacts.mimeType, sizeBytes: artifacts.sizeBytes })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId)))
    .limit(1);
  if (!artifact || artifact.format !== 'image' || !artifact.objectKey) throw new NotFoundException('Artifact content not found');
  const content = await storage.read(artifact.objectKey, MAX_LOCAL_FILE_BYTES);
  return {
    content,
    mimeType: artifact.mimeType ?? 'image/png',
    sizeBytes: artifact.sizeBytes ?? content.byteLength,
    fileName: `${artifact.id}.${artifact.mimeType === 'image/jpeg' ? 'jpg' : artifact.mimeType === 'image/gif' ? 'gif' : artifact.mimeType === 'image/webp' ? 'webp' : 'png'}`,
  };
}
