import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const IMAGE_OBJECT_KEY = /^artifacts\/art_[A-Za-z0-9-]+\.png$/;

@Injectable()
export class ArtifactStorageService {
  private readonly deploymentDirectory: string;

  constructor(config: ConfigService) {
    const configuredSqlitePath = config.get<string>('SQLITE_PATH') ?? '../../.data/deployment/worklite.db';
    const sqlitePath = isAbsolute(configuredSqlitePath) ? configuredSqlitePath : resolve(process.cwd(), configuredSqlitePath);
    this.deploymentDirectory = dirname(sqlitePath);
  }

  async writePng(id: string, content: Buffer): Promise<string> {
    if (!/^art_[A-Za-z0-9-]+$/.test(id)) throw new Error('Invalid image Artifact id.');
    const objectKey = `artifacts/${id}.png`;
    const path = this.pathFor(objectKey);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { flag: 'wx' });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
    return objectKey;
  }

  async read(objectKey: string): Promise<Buffer> {
    const path = this.pathFor(objectKey);
    try {
      return await readFile(path);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new NotFoundException('Artifact image not found.');
      }
      throw error;
    }
  }

  async remove(objectKey: string): Promise<void> {
    await rm(this.pathFor(objectKey), { force: true });
  }

  private pathFor(objectKey: string): string {
    if (!IMAGE_OBJECT_KEY.test(objectKey)) throw new NotFoundException('Artifact image not found.');
    return resolve(this.deploymentDirectory, objectKey);
  }
}
