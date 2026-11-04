import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { artifacts, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { ArtifactStorageService } from '../artifacts/artifact-storage.service';

@Controller('artifact-previews')
export class ArtifactPreviewController {
  private readonly links = new Map<string, { artifactId: string; workspaceId: string; expires: number }>();
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService, private readonly storage: ArtifactStorageService) {}

  @Get(':artifactId/open')
  async open(@Req() request: Request, @Param('artifactId') artifactId: string, @Res() response: Response) {
    const { id: workspaceId } = await this.workspaces.getWorkspace(request, 'personal');
    if (!this.find(workspaceId, artifactId)) throw new NotFoundException('Artifact not found.');
    for (const [key, value] of this.links) if (value.expires <= Date.now()) this.links.delete(key);
    const token = randomBytes(32).toString('hex');
    this.links.set(token, { artifactId, workspaceId, expires: Date.now() + 15 * 60_000 });
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(`/api/artifact-previews/view/${token}`);
  }

  @Get('view/:token')
  async view(@Param('token') token: string, @Res() response: Response) {
    const link = this.links.get(token);
    if (!link || link.expires <= Date.now()) { this.links.delete(token); throw new NotFoundException('Preview link expired. Open the artifact again.'); }
    const artifact = this.find(link.workspaceId, link.artifactId);
    if (!artifact) throw new NotFoundException('Artifact not found.');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (artifact.format === 'image' && artifact.objectKey) {
      response.type('image/png').send(await this.storage.read(artifact.objectKey));
      return;
    }
    const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
    let content = artifact.content;
    if (artifact.format === 'json') { try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Preserve stored text. */ } }
    response.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(artifact.name)}</title><style>body{max-width:960px;margin:40px auto;padding:0 24px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><pre>${escape(content)}</pre></html>`);
  }

  private find(workspaceId: string, artifactId: string) { return this.db.select().from(artifacts).where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, workspaceId))).get(); }
}
