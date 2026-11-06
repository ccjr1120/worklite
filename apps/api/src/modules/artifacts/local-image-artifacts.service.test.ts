import { createCanvas } from '@napi-rs/canvas';
import { BadRequestException, InternalServerErrorException, NotFoundException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { artifacts, createDb, initializeDatabase, type Database } from '@worklite/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStorageService } from './artifact-storage.service';
import { LocalImageArtifactsService } from './local-image-artifacts.service';
import { inspectLocalImage, MAX_LOCAL_IMAGE_BYTES, readLocalImage } from './local-image';

let directory: string;
let db: Database;
let storage: ArtifactStorageService;
let service: LocalImageArtifactsService;
const workspaceId = 'workspace_personal';
const png = () => createCanvas(3, 2).toBuffer('image/png');
const storedFiles = () => readdir(join(directory, 'artifacts')).catch(() => [] as string[]);

async function source(name = 'shot.png', body = png()) {
  const path = join(directory, name);
  await writeFile(path, body);
  return path;
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'worklite-local-images-')));
  db = createDb(':memory:');
  await initializeDatabase(db);
  storage = new ArtifactStorageService({ get: () => join(directory, 'worklite.db') } as unknown as ConfigService);
  service = new LocalImageArtifactsService(db, storage);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.$client.close();
  await rm(directory, { recursive: true, force: true });
});

describe('local image Artifacts', () => {
  it('registers multiple images, detects real types, and returns renderable URLs without source paths', async () => {
    const first = await source('private-source.jpg');
    const second = await source('disguised.png', createCanvas(3, 2).toBuffer('image/jpeg'));
    const { images } = await service.importImages(workspaceId, { files: [{ path: first, description: '首页截图' }, { path: second }] });
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ name: '首页截图', mimeType: 'image/png', width: 3, height: 2 });
    expect(images[1]).toMatchObject({ name: '图片 2', mimeType: 'image/jpeg' });
    expect(new Set(images.map((image) => image.id)).size).toBe(2);
    for (const image of images) {
      expect(image.id).toMatch(/^art_[A-Za-z0-9-]+$/);
      expect(image.contentUrl).toBe(`/api/artifacts/${image.id}/content`);
      expect(image.markdown).toBe(`![${image.name}](${image.contentUrl})`);
      const record = db.select().from(artifacts).where(eq(artifacts.id, image.id)).get()!;
      expect(record).toMatchObject({ workspaceId, format: 'image', placement: 'asset', sizeBytes: image.sizeBytes });
      expect(await storage.read(record.objectKey!)).toEqual(await readFile(image.mimeType === 'image/png' ? first : second));
    }
    expect(JSON.stringify(images)).not.toContain(directory);
    expect(JSON.stringify(images)).not.toContain('private-source');
    expect(JSON.stringify(images)).not.toContain('objectKey');
  });

  it('validates every image before writing and rejects a spoofed extension or corrupt image', async () => {
    const valid = await source();
    for (const body of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), png().subarray(0, 33)]) {
      const invalid = await source('fake.png', body);
      await expect(service.importImages(workspaceId, { files: [{ path: valid }, { path: invalid }] })).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(db.select().from(artifacts).all()).toEqual([]);
      expect(await storedFiles()).toEqual([]);
    }
  });

  it('supports GIF and WebP by content', async () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    expect(await inspectLocalImage(gif)).toMatchObject({ mimeType: 'image/gif', width: 1, height: 1 });
    expect(await inspectLocalImage(createCanvas(3, 2).toBuffer('image/webp'))).toMatchObject({ mimeType: 'image/webp', width: 3, height: 2 });
  });

  it('bounds file size, batch size, count and decoded dimensions', async () => {
    const large = await source();
    await truncate(large, MAX_LOCAL_IMAGE_BYTES + 1);
    await expect(service.importImages(workspaceId, { files: [{ path: large }] })).rejects.toBeInstanceOf(PayloadTooLargeException);
    const padded = Buffer.concat([png(), Buffer.alloc(MAX_LOCAL_IMAGE_BYTES - png().length)]);
    const full = await source('full.png', padded);
    await expect(service.importImages(workspaceId, { files: Array.from({ length: 5 }, () => ({ path: full })) })).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(service.importImages(workspaceId, { files: Array.from({ length: 9 }, () => ({ path: full })) })).rejects.toBeInstanceOf(BadRequestException);
    const bomb = png(); bomb.writeUInt32BE(100000, 16);
    await expect(inspectLocalImage(bomb)).rejects.toThrow('尺寸');
    expect(await storedFiles()).toEqual([]);
  });

  it('rejects relative paths, traversal, symlink files and symlink parents without disclosing paths', async () => {
    const path = await source();
    await symlink(path, join(directory, 'link.png'));
    await symlink(directory, join(directory, 'linked-directory'));
    for (const unsafe of ['relative.png', `${directory}/../shot.png`, join(directory, 'link.png'), join(directory, 'linked-directory', 'shot.png'), directory, `${directory}/missing-secret.png`, `${path}\0`]) {
      const error = await readLocalImage(unsafe).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(String(error)).not.toContain(directory);
      expect(String(error)).not.toContain('missing-secret');
    }
  });

  it('rolls back all database rows and removes all files when the second insert fails', async () => {
    db.$client.exec("CREATE TRIGGER reject_image BEFORE INSERT ON artifacts WHEN NEW.name = 'reject' BEGIN SELECT RAISE(ABORT, 'sensitive database details'); END");
    const path = await source();
    const error = await service.importImages(workspaceId, { files: [{ path }, { path, description: 'reject' }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(String(error)).not.toContain('sensitive');
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it('removes earlier files if a later storage operation fails', async () => {
    const write = storage.writeImage.bind(storage);
    vi.spyOn(storage, 'writeImage').mockImplementationOnce(write).mockRejectedValueOnce(new Error('/private/secret/path'));
    const path = await source();
    const error = await service.importImages(workspaceId, { files: [{ path }, { path }] }).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain('/private/secret/path');
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(await storedFiles()).toEqual([]);
  });

  it('reports cleanup failure explicitly and still rolls back database records', async () => {
    db.$client.exec("CREATE TRIGGER reject_images BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'rejected'); END");
    vi.spyOn(storage, 'remove').mockRejectedValue(new Error('/private/storage/permission-denied'));
    const path = await source();
    const error = await service.importImages(workspaceId, { files: [{ path }] }).catch((caught: unknown) => caught);
    expect(String(error)).toContain('清理未完成');
    expect(String(error)).not.toContain('/private/storage');
    expect(db.select().from(artifacts).all()).toEqual([]);
  });

  it('does not overwrite or delete an existing artifact during concurrent writes', async () => {
    const original = png();
    const results = await Promise.allSettled([storage.writePng('art_same', original), storage.writePng('art_same', Buffer.from('other'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? original : Buffer.from('other');
    expect(await storage.read('artifacts/art_same.png')).toEqual(winner);
    await expect(storage.writePng('art_same', Buffer.from('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await storage.read('artifacts/art_same.png')).toEqual(winner);
  });

  it('creates distinct persistent ids during concurrent imports', async () => {
    const path = await source();
    const results = await Promise.all([service.importImages(workspaceId, { files: [{ path }] }), service.importImages(workspaceId, { files: [{ path }] })]);
    expect(results[0]!.images[0]!.id).not.toBe(results[1]!.images[0]!.id);
    expect(db.select().from(artifacts).all()).toHaveLength(2);
    expect(await storedFiles()).toHaveLength(2);
  });

  it('refuses a symlink storage root, final symlinks and object-key traversal', async () => {
    const outside = join(directory, 'outside'); await mkdir(outside);
    await symlink(outside, join(directory, 'artifacts'));
    await expect(storage.writePng('art_escape', png())).rejects.toThrow('directory is invalid');
    expect(await readdir(outside)).toEqual([]);
    await rm(join(directory, 'artifacts')); await mkdir(join(directory, 'artifacts'));
    const privateFile = await source('private.png');
    await symlink(privateFile, join(directory, 'artifacts', 'art_link.png'));
    await expect(storage.read('artifacts/art_link.png')).rejects.toBeDefined();
    await expect(storage.writePng('art_link', png())).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(storage.read('artifacts/../private.png')).rejects.toBeInstanceOf(NotFoundException);
    expect(await readFile(privateFile)).toEqual(png());
  });

  it('rejects unexpected fields and prevents paths or Markdown injection in descriptions', async () => {
    const path = await source();
    for (const input of [null, { files: [] }, { workspaceId: 'other', files: [{ path }] }, { files: [{ path, extra: true }] }, { files: [{ path, description: '/private/secret' }] }, { files: [{ path, description: 'first\nsecond' }] }]) {
      await expect(service.importImages(workspaceId, input)).rejects.toBeInstanceOf(BadRequestException);
    }
    const { images } = await service.importImages(workspaceId, { files: [{ path, description: '截图](javascript:alert(1))' }] });
    expect(images[0]!.markdown).not.toContain('](javascript:');
  });
});
