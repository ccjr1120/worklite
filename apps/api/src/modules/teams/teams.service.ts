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

  async getWorkspace(_request: unknown, _slug = PERSONAL_WORKSPACE_SLUG) {
    const [row] = await this.db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces).where(eq(workspaces.slug, PERSONAL_WORKSPACE_SLUG)).limit(1);
    const [fallback] = row ? [row] : await this.db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces).limit(1);
    if (!fallback) throw new NotFoundException('Personal workspace not found');
    return fallback;
  }
}
