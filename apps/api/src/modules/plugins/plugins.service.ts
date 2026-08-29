import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { PluginTestResult, PluginView, UpdatePluginRequest } from '@worklite/contracts';
import { plugins, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';

export const CODEX_CLI_PLUGIN_ID = 'codex-cli-chat' as const;
export const CODEX_CLI_AGENT_ID = 'agt_codex_cli_chat' as const;

@Injectable()
export class PluginsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<PluginView[]> {
    const rows = await this.db.select().from(plugins).orderBy(plugins.name);
    return rows.map((row) => this.toView(row));
  }

  async get(pluginId: string): Promise<PluginView> {
    const [row] = await this.db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    if (!row) throw new NotFoundException('Plugin not found.');
    return this.toView(row);
  }

  async command(pluginId: string): Promise<string> {
    const [row] = await this.db.select({ command: plugins.command }).from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    if (!row) throw new NotFoundException('Plugin not found.');
    return row.command;
  }

  async update(pluginId: string, input: UpdatePluginRequest): Promise<PluginView> {
    const command = this.normalizeCommand(input?.command);
    const [updated] = await this.db.update(plugins).set({ command, updatedAt: new Date() }).where(eq(plugins.id, pluginId)).returning();
    if (!updated) throw new NotFoundException('Plugin not found.');
    return this.toView(updated);
  }

  async test(pluginId: string): Promise<PluginTestResult> {
    const command = await this.command(pluginId);
    return this.probe(command);
  }

  private toView(row: typeof plugins.$inferSelect): PluginView {
    const availability = this.probe(row.command);
    return {
      id: row.id as PluginView['id'],
      name: row.name,
      description: row.description,
      command: row.command,
      enabled: availability.enabled,
      status: availability.status,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private normalizeCommand(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('A plugin command is required.');
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new BadRequestException('A plugin command must be a single line.');
    return value.trim();
  }

  private probe(command: string): PluginTestResult {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === 'ENOENT') return { enabled: false, status: 'missing' };
    return result.status === 0 ? { enabled: true, status: 'available' } : { enabled: false, status: 'failed' };
  }
}
