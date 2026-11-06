import { Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ImageExtension } from './local-image';

const ARTIFACT_OBJECT_KEY = /^artifacts\/art_[A-Za-z0-9-]+\.(png|jpg|gif|webp|bin)$/;

export class ArtifactStorageCleanupError extends Error {
  constructor() { super('Artifact file cleanup failed.'); }
}

@Injectable()
export class ArtifactStorageService {
  private readonly deploymentDirectory: string;

  constructor(config: ConfigService) {
    const configuredSqlitePath = config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db';
    const sqlitePath = isAbsolute(configuredSqlitePath) ? configuredSqlitePath : resolve(process.cwd(), configuredSqlitePath);
    this.deploymentDirectory = dirname(sqlitePath);
  }

  async writePng(id: string, content: Buffer): Promise<string> {
    return this.writeImage(id, content, 'png');
  }

  async writeImage(id: string, content: Buffer, extension: ImageExtension): Promise<string> {
    return this.write(id, content, extension);
  }

  async writeFile(id: string, content: Buffer): Promise<string> {
    return this.write(id, content, 'bin');
  }

  private async write(id: string, content: Buffer, extension: string): Promise<string> {
    if (!/^art_[A-Za-z0-9-]+$/.test(id)) throw new Error('Invalid Artifact id.');
    const objectKey = `artifacts/${id}.${extension}`;
    const path = await this.pathFor(objectKey, true);
    const directory = await lstat(dirname(path));
    // Acquire ownership before cleanup becomes possible. EEXIST must never remove a
    // file belonging to an earlier or concurrent upload (including a dangling symlink).
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let identity: Awaited<ReturnType<typeof handle.stat>> | undefined;
    try {
      // Recheck after opening, before writing any bytes, so a replaced parent or
      // redirected path cannot silently turn a storage write into an arbitrary file copy.
      const parent = await lstat(dirname(path));
      const owned = await handle.stat();
      identity = owned;
      const entry = await lstat(path);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== directory.dev || parent.ino !== directory.ino
        || entry.isSymbolicLink() || entry.dev !== owned.dev || entry.ino !== owned.ino || await realpath(dirname(path)) !== dirname(path)) {
        throw new Error('Artifact storage directory changed.');
      }
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
    } catch (error) {
      const owned = await handle.stat().catch(() => identity);
      await handle.close().catch(() => undefined);
      try {
        const entry = await lstat(path).catch((failure: unknown) => {
          if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'ENOENT') return null;
          throw failure;
        });
        if (!owned || (entry && (entry.dev !== owned.dev || entry.ino !== owned.ino)) || (!entry && owned.nlink > 0)) throw new ArtifactStorageCleanupError();
        if (entry) await rm(path, { force: true });
      }
      catch { throw new ArtifactStorageCleanupError(); }
      throw error;
    }
    return objectKey;
  }

  async read(objectKey: string, maxBytes?: number): Promise<Buffer> {
    try {
      const path = await this.pathFor(objectKey);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new NotFoundException('Artifact content not found.');
        if (maxBytes !== undefined) {
          if (stat.size > maxBytes) throw new PayloadTooLargeException('文件超过当前渠道的发送上限。');
          const content = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
          let length = 0;
          while (length < content.length) {
            const read = await handle.read(content, length, content.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length > maxBytes || length !== stat.size) throw new PayloadTooLargeException('文件大小发生变化或超过发送上限。');
          return content.subarray(0, length);
        }
        return await handle.readFile();
      }
      finally { await handle.close(); }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundException('Artifact content not found.');
      }
      throw error;
    }
  }

  async remove(objectKey: string): Promise<void> {
    try { await rm(await this.pathFor(objectKey), { force: true }); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  private async pathFor(objectKey: string, create = false): Promise<string> {
    if (!ARTIFACT_OBJECT_KEY.test(objectKey)) throw new NotFoundException('Artifact content not found.');
    if (create) await mkdir(this.deploymentDirectory, { recursive: true });
    // The configured deployment directory is the trust anchor, including OS aliases.
    // The artifact directory itself must be a real child, never a redirected symlink.
    const deployment = await realpath(this.deploymentDirectory);
    const root = join(deployment, 'artifacts');
    if (create) await mkdir(root, { recursive: false }).catch((error: unknown) => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const entry = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(root) !== root) throw new Error('Artifact storage directory is invalid.');
    return join(root, basename(objectKey));
  }
}
