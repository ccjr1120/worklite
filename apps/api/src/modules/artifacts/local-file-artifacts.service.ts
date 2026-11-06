import { BadRequestException, Inject, Injectable, InternalServerErrorException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { artifacts, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { ArtifactStorageCleanupError, ArtifactStorageService } from './artifact-storage.service';
import { fileMarkdown, MAX_LOCAL_FILE_BATCH_BYTES, MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILES, readLocalFile, safeFileName } from './local-file';

@Injectable()
export class LocalFileArtifactsService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly storage: ArtifactStorageService) {}

  async importFiles(workspaceId: string, input: unknown) {
    const files = parseInput(input);
    const prepared: Array<{ id: string; name: string; body: Buffer }> = [];
    let total = 0;
    for (const file of files) {
      const body = await readLocalFile(file.path, MAX_LOCAL_FILE_BYTES);
      total += body.length;
      if (total > MAX_LOCAL_FILE_BATCH_BYTES) throw new PayloadTooLargeException('每批文件合计不能超过 40 MB。');
      prepared.push({ id: `art_${randomUUID()}`, name: safeFileName(basename(file.path)), body });
    }
    const keys: string[] = [];
    const records: Array<typeof artifacts.$inferInsert> = [];
    const result: Array<{ id: string; name: string; mimeType: string; sizeBytes: number; contentUrl: string; markdown: string }> = [];
    try {
      for (const file of prepared) {
        const objectKey = await this.storage.writeFile(file.id, file.body);
        keys.push(objectKey);
        // 'unsupported' means no inline preview. Opaque files always download as attachments.
        records.push({ id: file.id, workspaceId, name: file.name, format: 'unsupported', placement: 'asset', content: '', objectKey,
          mimeType: 'application/octet-stream', size: `${file.body.length} B`, sizeBytes: file.body.length });
        const contentUrl = `/api/artifacts/${file.id}/content?download=true`;
        result.push({ id: file.id, name: file.name, mimeType: 'application/octet-stream', sizeBytes: file.body.length,
          contentUrl, markdown: fileMarkdown(file.name, contentUrl) });
      }
      this.db.transaction((tx) => { for (const record of records) tx.insert(artifacts).values(record).run(); });
    } catch (error) {
      const cleanup = await Promise.allSettled(keys.map((key) => this.storage.remove(key)));
      if (error instanceof ArtifactStorageCleanupError || cleanup.some((result) => result.status === 'rejected')) {
        throw new InternalServerErrorException('文件登记失败，存储清理未完成。');
      }
      throw new InternalServerErrorException('文件登记失败，本批未登记任何产物。');
    }
    return { files: result };
  }
}

function parseInput(input: unknown): Array<{ path: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'files')) throw new BadRequestException('仅接受 files 文件数组。');
  const files = (input as { files?: unknown }).files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_LOCAL_FILES) throw new BadRequestException('files 必须包含 1 至 8 个文件。');
  return files.map((file: unknown) => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some((key) => key !== 'path')) throw new BadRequestException('每个文件仅接受 path。');
    const { path } = file as Record<string, unknown>;
    if (typeof path !== 'string' || !path.length || path.length > 4096) throw new BadRequestException('path 必须是长度不超过 4096 的本地绝对路径。');
    return { path };
  });
}
