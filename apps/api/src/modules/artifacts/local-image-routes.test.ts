import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { createDb, initializeDatabase, type Database } from '@worklite/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceResourcesController } from '../teams/team-resources.controller';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import type { WorkspaceService } from '../teams/teams.service';
import type { LocalImageArtifactsService } from './local-image-artifacts.service';

let db: Database | undefined;
afterEach(() => { db?.$client.close(); db = undefined; });

describe('local image Artifact routes', () => {
  it('binds POST imports to the request workspace and passes the exact batch', async () => {
    const request = {} as Request;
    const body = { files: [{ path: '/tmp/one.png' }, { path: '/tmp/two.jpg', description: '第二张' }] };
    const result = { images: [{ id: 'art_image', contentUrl: '/api/artifacts/art_image/content' }] };
    const importer = { importImages: vi.fn().mockResolvedValue(result) };
    const workspaces = { getWorkspace: vi.fn().mockResolvedValue({ id: 'workspace_selected' }) };
    const controller = new WorkspaceResourcesController({} as WorkspaceResourcesService, importer as unknown as LocalImageArtifactsService, workspaces as unknown as WorkspaceService);
    expect(await controller.importLocalImages(request, body)).toBe(result);
    expect(workspaces.getWorkspace).toHaveBeenCalledWith(request, 'personal');
    expect(importer.importImages).toHaveBeenCalledWith('workspace_selected', body);
  });

  it('serves the existing content route with the detected MIME and enforces workspace isolation', async () => {
    db = createDb(':memory:'); await initializeDatabase(db);
    db.$client.exec("INSERT INTO artifacts (id, workspace_id, name, format, object_key, mime_type, size_bytes) VALUES ('art_local', 'workspace_personal', '截图', 'image', 'artifacts/art_local.jpg', 'image/jpeg', 3)");
    const storage = { read: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])) };
    const workspaces = { getWorkspace: vi.fn().mockResolvedValue({ id: 'workspace_personal' }) };
    const resources = Object.assign(Object.create(WorkspaceResourcesService.prototype) as WorkspaceResourcesService, { db, artifactStorage: storage, workspaces });
    const controller = new WorkspaceResourcesController(resources, {} as LocalImageArtifactsService, workspaces as unknown as WorkspaceService);
    const image = await controller.artifactContent({} as Request, 'art_local');
    expect(image.getHeaders()).toEqual({ type: 'image/jpeg', disposition: 'inline; filename="art_local.jpg"', length: 3 });
    expect(storage.read).toHaveBeenCalledWith('artifacts/art_local.jpg');
    storage.read.mockClear();
    workspaces.getWorkspace.mockResolvedValue({ id: 'another_workspace' });
    await expect(controller.artifactContent({} as Request, 'art_local')).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.read).not.toHaveBeenCalled();
  });
});
