import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { PluginTestResult, PluginView, UpdatePluginRequest } from '@worklite/contracts';
import { feishuRegistrations, plugins, wechatOfficialAccounts, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const FEISHU_PLUGIN_ID = 'feishu-bot' as const;
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
    if (pluginId === FEISHU_PLUGIN_ID) {
      const config = input?.feishu;
      if (!config?.appId?.trim() || !config.allowedUserId?.trim()) throw new BadRequestException('Feishu App ID and allowed user open id are required.');
      const [row] = await this.db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
      if (!row) throw new NotFoundException('Plugin not found.');
      if (!config.appSecret?.trim() && (!row.feishuAppSecret || row.feishuAppId !== config.appId.trim())) throw new BadRequestException('A Feishu App Secret is required for this application.');
      await this.db.update(plugins).set({
        feishuAppId: config.appId.trim(), feishuAllowedUserId: config.allowedUserId.trim(),
        ...(config.appSecret?.trim() ? { feishuAppSecret: encryptSecret(config.appSecret.trim()) } : {}),
        feishuEnabled: true, feishuStatus: 'connecting', feishuLastError: null, updatedAt: new Date(),
      }).where(eq(plugins.id, pluginId));
      return this.get(pluginId);
    }
    if (pluginId !== CODEX_CLI_PLUGIN_ID) throw new BadRequestException('This plugin has no executable command configuration.');
    const command = this.normalizeCommand(input?.command);
    const [updated] = await this.db.update(plugins).set({ command, updatedAt: new Date() }).where(eq(plugins.id, pluginId)).returning();
    if (!updated) throw new NotFoundException('Plugin not found.');
    return this.toView(updated);
  }

  async test(pluginId: string): Promise<PluginTestResult> {
    if (pluginId !== CODEX_CLI_PLUGIN_ID) throw new BadRequestException('Only executable plugins support command testing.');
    return this.probe(await this.command(pluginId));
  }

  async feishuSecret() {
    const [row] = await this.db.select().from(plugins).where(eq(plugins.id, FEISHU_PLUGIN_ID)).limit(1);
    if (!row) throw new NotFoundException('Feishu plugin not found.');
    return { ...row, appSecret: row.feishuAppSecret ? decryptSecret(row.feishuAppSecret) : null };
  }

  async updateFeishu(patch: Partial<typeof plugins.$inferInsert>): Promise<PluginView> {
    await this.db.update(plugins).set({ ...patch, updatedAt: new Date() }).where(eq(plugins.id, FEISHU_PLUGIN_ID));
    return this.get(FEISHU_PLUGIN_ID);
  }

  private async toView(row: typeof plugins.$inferSelect): Promise<PluginView> {
    const availability = row.id !== CODEX_CLI_PLUGIN_ID
      ? { enabled: true, status: 'available' as const }
      : this.probe(row.command);
    const [officialAccount] = row.id === WECHAT_OFFICIAL_ACCOUNT_PLUGIN_ID
      ? await this.db.select().from(wechatOfficialAccounts).where(eq(wechatOfficialAccounts.workspaceId, row.workspaceId)).limit(1)
      : [];
    const [registration] = row.id === FEISHU_PLUGIN_ID
      ? await this.db.select().from(feishuRegistrations).where(eq(feishuRegistrations.pluginId, row.id)).limit(1)
      : [];
    return {
      id: row.id as PluginView['id'],
      name: row.name,
      description: row.description,
      command: row.command,
      enabled: availability.enabled,
      status: availability.status,
      updatedAt: row.updatedAt.toISOString(),
      feishu: row.id === FEISHU_PLUGIN_ID ? {
        appId: row.feishuAppId, hasAppSecret: Boolean(row.feishuAppSecret),
        allowedUserId: row.feishuAllowedUserId, status: row.feishuStatus, lastError: row.feishuLastError,
        registration: registration ? {
          id: registration.id, status: registration.status,
          verificationUrl: registration.verificationUrl,
          expiresAt: registration.expiresAt?.toISOString() ?? null, error: registration.error,
        } : null,
      } : undefined,
      officialAccount: officialAccount ? {
        id: officialAccount.id,
        displayName: officialAccount.displayName,
        status: officialAccount.status,
        qrCode: officialAccount.qrCode,
        qrExpiresAt: officialAccount.qrExpiresAt?.toISOString() ?? null,
        lastVerifiedAt: officialAccount.lastVerifiedAt?.toISOString() ?? null,
        lastError: officialAccount.lastError,
        updatedAt: officialAccount.updatedAt.toISOString(),
      } : undefined,
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

const WECHAT_OFFICIAL_ACCOUNT_PLUGIN_ID = 'wechat-official-account' as const;
export const WECHAT_OFFICIAL_ACCOUNT_ID = 'wechat_official_account_personal' as const;

export { decryptSecret, encryptSecret };
