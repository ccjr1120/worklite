// @vitest-environment node
import { BadRequestException, InternalServerErrorException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { artifacts, createDb, initializeDatabase, type Database } from '@worklite/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStorageService } from './artifact-storage.service';
import { LocalFileArtifactsService } from './local-file-artifacts.service';
import { readArtifactFileContent } from './artifact-file-content';
import { MAX_LOCAL_FILE_BYTES, readLocalFile } from './local-file';
import { WorkspaceResourcesController } from '../teams/team-resources.controller';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { LocalImageArtifactsService } from './local-image-artifacts.service';
import type { WorkspaceService } from '../teams/teams.service';

let directory: string;
let db: Database;
let storage: ArtifactStorageService;
let service: LocalFileArtifactsService;
const workspaceId = 'workspace_personal';
const stored = () => readdir(join(directory, 'artifacts')).catch(() => [] as string[]);
const source = async (name: string, content = 'original bytes') => {
  const path = join(directory, name); await writeFile(path, content); return path;
};
beforeEach(async () => {
  const root = resolve('.data/test-tmp'); await mkdir(root, { recursive: true });
  directory = await realpath(await mkdtemp(join(root, 'local-files-')));
  db = createDb(':memory:'); await initializeDatabase(db);
  storage = new ArtifactStorageService({ get: () => join(directory, 'worklite.db') } as unknown as ConfigService);
  service = new LocalFileArtifactsService(db, storage);
});
afterEach(async () => { vi.restoreAllMocks(); db.$client.close(); await rm(directory, { recursive: true, force: true }); });

describe('local file registration and download', () => {
  it('preserves Unicode names, arbitrary bytes and order; isolates workspace and returns download-only links', async () => {
    const first = await source('报告 [终稿].pdf', '%PDF fake\0');
    const second = await source('archive.unknown', 'zip-like bytes');
    const result = await service.importFiles(workspaceId, { files: [{ path: first }, { path: second }] });
    expect(result.files.map((file) => file.name)).toEqual(['报告 [终稿].pdf', 'archive.unknown']);
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(result)).not.toContain('objectKey');
    for (const [index, file] of result.files.entries()) {
      expect(file.contentUrl).toBe(`/api/artifacts/${file.id}/content?download=true`);
      expect(file.markdown).toContain(`](${file.contentUrl})`);
      const content = await readArtifactFileContent(db, storage, workspaceId, file.id);
      expect(content.content.toString()).toBe(index ? 'zip-like bytes' : '%PDF fake\0');
      expect(content.fileName).toBe(file.name);
      await expect(readArtifactFileContent(db, storage, 'other_workspace', file.id)).rejects.toBeInstanceOf(NotFoundException);
    }
    const workspaces = { getWorkspace: vi.fn().mockResolvedValue({ id: workspaceId }) };
    const resources = Object.assign(Object.create(WorkspaceResourcesService.prototype), { db, artifactStorage: storage, workspaces });
    const controller = new WorkspaceResourcesController(resources, {} as LocalImageArtifactsService, workspaces as unknown as WorkspaceService, service);
    const download = await controller.artifactContent({} as Request, result.files[0].id);
    expect(download.getHeaders()).toMatchObject({ type: 'application/octet-stream', disposition: `attachment; filename*=UTF-8''${encodeURIComponent('报告 [终稿].pdf')}` });
    await resources.deleteArtifact({} as Request, 'personal', result.files[0].id);
    expect(await stored()).toHaveLength(1);
  });

  it('binds the protected import endpoint to the request workspace', async () => {
    const importer = { importFiles: vi.fn().mockResolvedValue({ files: [] }) };
    const workspaces = { getWorkspace: vi.fn().mockResolvedValue({ id: 'selected_workspace' }) };
    const controller = new WorkspaceResourcesController({} as WorkspaceResourcesService, {} as LocalImageArtifactsService, workspaces as unknown as WorkspaceService, importer as unknown as LocalFileArtifactsService);
    const body = { files: [{ path: '/absolute/report.pdf' }] }; const request = {} as Request;
    await controller.importLocalFiles(request, body);
    expect(importer.importFiles).toHaveBeenCalledWith('selected_workspace', body);
    expect(workspaces.getWorkspace).toHaveBeenCalledWith(request, 'personal');
  });

  it('rejects invalid paths, empty files, symlinks and oversize before persisting any batch member', async () => {
    const good = await source('good.docx');
    const empty = await source('empty', '');
    const big = await source('big.zip'); await truncate(big, MAX_LOCAL_FILE_BYTES + 1);
    const link = join(directory, 'link'); await symlink(good, link);
    const folderLink = join(directory, 'linked-folder'); await symlink(directory, folderLink);
    for (const path of [empty, link, join(folderLink, 'good.docx'), directory, './relative', join(directory, 'missing'), `${directory}/../escape`]) {
      await expect(service.importFiles(workspaceId, { files: [{ path: good }, { path }] })).rejects.toBeInstanceOf(BadRequestException);
      expect(db.select().from(artifacts).all()).toEqual([]);
    }
    await expect(readLocalFile(big, MAX_LOCAL_FILE_BYTES)).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(await stored()).toEqual([]);
  });

  it('bounds batch count and total bytes and accepts the exact single-file boundary', async () => {
    const path = await source('limit.bin'); await truncate(path, MAX_LOCAL_FILE_BYTES);
    await expect(service.importFiles(workspaceId, { files: Array.from({ length: 9 }, () => ({ path })) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.importFiles(workspaceId, { files: [{ path }, { path }, { path }] })).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(db.select().from(artifacts).all()).toEqual([]);
    const result = await service.importFiles(workspaceId, { files: [{ path }] });
    expect(result.files[0].sizeBytes).toBe(MAX_LOCAL_FILE_BYTES);
    expect((await readArtifactFileContent(db, storage, workspaceId, result.files[0].id)).content.length).toBe(MAX_LOCAL_FILE_BYTES);
    await expect(storage.read(db.select().from(artifacts).get()!.objectKey!, 100)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('rolls back storage and rows when a later write fails without leaking private paths', async () => {
    const path = await source('private.doc');
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, 'writeFile').mockImplementationOnce(write).mockRejectedValueOnce(new Error(path));
    await expect(service.importFiles(workspaceId, { files: [{ path }, { path }] })).rejects.toThrow(new InternalServerErrorException('文件登记失败，本批未登记任何产物。'));
    expect(db.select().from(artifacts).all()).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('exports existing text, markdown and JSON Artifacts without regenerating content', async () => {
    for (const format of ['text', 'markdown', 'json'] as const) {
      const id = `art_${format}`;
      db.insert(artifacts).values({ id, workspaceId, name: '产物', format, content: '原始 UTF-8 内容\n' }).run();
      const file = await readArtifactFileContent(db, storage, workspaceId, id);
      expect(file.content.toString()).toBe('原始 UTF-8 内容\n');
      expect(file.fileName).toBe(`产物.${format === 'text' ? 'txt' : format === 'markdown' ? 'md' : 'json'}`);
    }
  });
});
