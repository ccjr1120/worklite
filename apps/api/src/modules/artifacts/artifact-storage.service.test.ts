// @vitest-environment node
import type { ConfigService } from '@nestjs/config';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStorageService } from './artifact-storage.service';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let directory: string;
let storage: ArtifactStorageService;
beforeEach(async () => {
  directory = await files.realpath(await files.mkdtemp(join(tmpdir(), 'worklite-image-storage-')));
  storage = new ArtifactStorageService({ get: () => join(directory, 'db.sqlite') } as unknown as ConfigService);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await files.rm(directory, { recursive: true, force: true });
});

describe('Artifact storage failure cleanup', () => {
  it('removes a partially written file when the filesystem write fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(files.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await write(Buffer.from('partial'));
        throw new Error('disk full');
      });
      return handle;
    });
    await expect(storage.writePng('art_partial', Buffer.from('complete image'))).rejects.toThrow('disk full');
    expect(await files.readdir(join(directory, 'artifacts'))).toEqual([]);
  });

  it('removes the file when syncing it fails before registration', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(files.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'));
      return handle;
    });
    await expect(storage.writePng('art_sync', Buffer.from('image'))).rejects.toThrow('sync failed');
    expect(await files.readdir(join(directory, 'artifacts'))).toEqual([]);
  });
});
