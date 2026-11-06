import { BadRequestException, Inject, Injectable, InternalServerErrorException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { artifacts, type Database } from '@worklite/db';
import type { LocalImageArtifactView } from '@worklite/contracts';
import { DATABASE } from '../../infrastructure/database.module';
import { ArtifactStorageCleanupError, ArtifactStorageService } from './artifact-storage.service';
import { inspectLocalImage, MAX_LOCAL_IMAGE_BATCH_BYTES, MAX_LOCAL_IMAGES, readLocalImage } from './local-image';

@Injectable()
export class LocalImageArtifactsService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly storage: ArtifactStorageService) {}

  async importImages(workspaceId: string, input: unknown): Promise<{ images: LocalImageArtifactView[] }> {
    const files = parseInput(input);
    const prepared: Array<{ id: string; name: string; body: Buffer } & Awaited<ReturnType<typeof inspectLocalImage>>> = [];
    let total = 0;
    // Validate the complete batch before persisting anything; memory and decode work are bounded.
    for (const [index, file] of files.entries()) {
      const body = await readLocalImage(file.path);
      total += body.length;
      if (total > MAX_LOCAL_IMAGE_BATCH_BYTES) throw new PayloadTooLargeException('每批图片合计不能超过 40 MB。');
      const image = await inspectLocalImage(body);
      prepared.push({ id: `art_${randomUUID()}`, name: file.description ?? `图片 ${index + 1}`, body, ...image });
    }
    const keys: string[] = [];
    const records: Array<typeof artifacts.$inferInsert> = [];
    const images: LocalImageArtifactView[] = [];
    try {
      for (const image of prepared) {
        const objectKey = await this.storage.writeImage(image.id, image.body, image.extension);
        keys.push(objectKey);
        records.push({ id: image.id, workspaceId, name: image.name, format: 'image', placement: 'asset', content: '', objectKey,
          mimeType: image.mimeType, width: image.width, height: image.height, size: `${image.body.length} B`, sizeBytes: image.body.length });
        const contentUrl = `/api/artifacts/${image.id}/content`;
        const alt = image.name.replace(/[\[\]\\()<>`*_!]/g, ' ').trim();
        images.push({ id: image.id, name: image.name, mimeType: image.mimeType, sizeBytes: image.body.length,
          width: image.width, height: image.height, contentUrl, markdown: `![${alt}](${contentUrl})` });
      }
      // Synchronous SQLite transaction: no record can become visible until every file exists.
      this.db.transaction((tx) => { for (const record of records) tx.insert(artifacts).values(record).run(); });
    } catch (error) {
      const cleanup = await Promise.allSettled(keys.map((key) => this.storage.remove(key)));
      if (error instanceof ArtifactStorageCleanupError || cleanup.some((result) => result.status === 'rejected')) {
        throw new InternalServerErrorException('图片登记失败，存储清理未完成。');
      }
      // Never expose the source path, object key, SQLite error or native filesystem error.
      throw new InternalServerErrorException('图片登记失败，本批未登记任何产物。');
    }
    return { images };
  }
}

function parseInput(input: unknown): Array<{ path: string; description?: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'files')) throw new BadRequestException('仅接受 files 图片数组。');
  const files = (input as { files?: unknown }).files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_LOCAL_IMAGES) throw new BadRequestException('files 必须包含 1 至 8 张图片。');
  return files.map((file: unknown) => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some((key) => !['path', 'description'].includes(key))) throw new BadRequestException('每张图片仅接受 path 和 description。');
    const { path, description } = file as Record<string, unknown>;
    if (typeof path !== 'string' || !path.length || path.length > 4096) throw new BadRequestException('path 必须是长度不超过 4096 的本地绝对路径。');
    if (description !== undefined && (typeof description !== 'string' || !description.trim() || description.length > 200 || /[\/\\\x00-\x1f\x7f\u2028\u2029]/.test(description))) throw new BadRequestException('description 必须是 1 至 200 字的单行描述，不能包含路径分隔符。');
    return { path, ...(typeof description === 'string' ? { description: description.trim() } : {}) };
  });
}
