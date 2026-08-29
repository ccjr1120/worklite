import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { WorkspaceView } from '@worklite/contracts';
import { workspaces, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
const PERSONAL_WORKSPACE_SLUG = 'personal';

@Injectable()
export class WorkspaceService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<WorkspaceView[]> {
    const rows = await this.db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces).limit(1);
    return rows;
  }

  async getWorkspace(_request: unknown, slug = PERSONAL_WORKSPACE_SLUG) {
    const [workspace] = await this.db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    if (!workspace) throw new NotFoundException(`Workspace ${slug} not found`);
    return workspace;
  }
}
