import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { count, eq } from 'drizzle-orm';
import type { PluginTestResult, PluginView, UpdatePluginRequest } from '@worklite/contracts';
import { pluginWechatConversations, plugins, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const CODEX_CLI_PLUGIN_ID = 'codex-cli-chat' as const;
export const CODEX_CLI_AGENT_ID = 'agt_codex_cli_chat' as const;

@Injectable()
export class PluginsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<PluginView[]> {
    const rows = await this.db.select().from(plugins).orderBy(plugins.name);
    return Promise.all(rows.map((row) => this.toView(row)));
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

  async commandArguments(pluginId: string): Promise<string[]> {
    return parsePluginCommand(await this.command(pluginId));
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

  async updateWechat(pluginId: string, patch: Partial<typeof plugins.$inferInsert>): Promise<PluginView> {
    const [updated] = await this.db.update(plugins).set({ ...patch, updatedAt: new Date() }).where(eq(plugins.id, pluginId)).returning();
    if (!updated) throw new NotFoundException('Plugin not found.');
    return this.toView(updated);
  }

  async wechatSecret(pluginId: string): Promise<{ token: string | null; baseUrl: string }> {
    const [row] = await this.db.select({ token: plugins.wechatToken, baseUrl: plugins.wechatBaseUrl }).from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    if (!row) throw new NotFoundException('Plugin not found.');
    return { token: row.token ? decryptSecret(row.token) : null, baseUrl: row.baseUrl };
  }

  private async toView(row: typeof plugins.$inferSelect): Promise<PluginView> {
    const availability = this.probe(row.command);
    const [{ value: conversationCount }] = await this.db.select({ value: count() }).from(pluginWechatConversations).where(eq(pluginWechatConversations.pluginId, row.id));
    return {
      id: row.id as PluginView['id'],
      name: row.name,
      description: row.description,
      command: row.command,
      enabled: availability.enabled,
      status: availability.status,
      updatedAt: row.updatedAt.toISOString(),
      wechat: {
        status: row.wechatStatus,
        baseUrl: row.wechatBaseUrl,
        botId: row.wechatBotId,
        qrCode: row.wechatQrCode,
        lastError: row.wechatLastError,
        conversationCount,
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  }

  private normalizeCommand(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('A plugin command is required.');
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new BadRequestException('A plugin command must be a single line.');
    const command = value.trim();
    parsePluginCommand(command);
    return command;
  }

  private probe(command: string): PluginTestResult {
    const [executable, ...argumentsValue] = parsePluginCommand(command);
    const result = spawnSync(executable, [...argumentsValue, '--version'], { stdio: 'ignore' });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (errorCode === 'ENOENT') return { enabled: false, status: 'missing' };
    return result.status === 0 ? { enabled: true, status: 'available' } : { enabled: false, status: 'failed' };
  }
}

function parsePluginCommand(command: string): string[] {
  const values: string[] = [];
  let value = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const character of command) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') escaped = true;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) values.push(value);
      value = '';
      started = false;
      continue;
    }
    value += character;
    started = true;
  }

  if (escaped || quote) throw new BadRequestException('The plugin command contains incomplete quoting.');
  if (started) values.push(value);
  if (!values[0]) throw new BadRequestException('A plugin executable is required.');
  return values;
}

function encryptSecret(value: string): string {
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

export { encryptSecret };
