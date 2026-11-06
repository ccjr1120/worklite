import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { ChatChannelConfigurationView, UpdateChatChannelRequest } from '@worklite/contracts';
import { chatChannels, feishuRegistrations, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { decryptSecret, encryptSecret } from './connection-secrets';
import type { WechatService } from './wechat/wechat.service';

export const FEISHU_CHANNEL_ID = 'feishu' as const;
export const WECHAT_CHANNEL_ID = 'wechat' as const;

@Injectable()
export class ChatChannelConfigurationService {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly modules: ModuleRef) {}

  async get(channelId: string): Promise<ChatChannelConfigurationView> {
    const row = await this.requireChannel(channelId);
    const [registration] = channelId === FEISHU_CHANNEL_ID
      ? await this.db.select().from(feishuRegistrations).where(eq(feishuRegistrations.channelId, channelId)).limit(1)
      : [];
    return {
      id: channelId as ChatChannelConfigurationView['id'], updatedAt: row.updatedAt.toISOString(),
      feishu: channelId === FEISHU_CHANNEL_ID ? {
        appId: row.feishuAppId, hasAppSecret: Boolean(row.feishuAppSecret),
        allowedUserId: row.feishuAllowedUserId, status: row.feishuStatus, lastError: row.feishuLastError,
        registration: registration ? {
          id: registration.id, status: registration.status, verificationUrl: registration.verificationUrl,
          expiresAt: registration.expiresAt?.toISOString() ?? null, error: registration.error,
        } : null,
      } : undefined,
      wechat: channelId === WECHAT_CHANNEL_ID ? {
        botId: row.wechatBotId, hasToken: Boolean(row.wechatBotToken), allowedUserId: row.wechatAllowedUserId,
        status: row.wechatStatus, lastError: row.wechatLastError,
        login: this.modules.get<WechatService | undefined>('WECHAT_UPGRADE_TRANSPORT', { strict: false })?.loginView() ?? null,
      } : undefined,
    };
  }

  async update(channelId: string, input: UpdateChatChannelRequest): Promise<ChatChannelConfigurationView> {
    const row = await this.requireChannel(channelId);
    if (channelId === FEISHU_CHANNEL_ID) {
      const config = input?.feishu;
      if (!config?.appId?.trim() || !config.allowedUserId?.trim()) throw new BadRequestException('Feishu App ID and allowed user open id are required.');
      if (!config.appSecret?.trim() && (!row.feishuAppSecret || row.feishuAppId !== config.appId.trim())) throw new BadRequestException('A Feishu App Secret is required for this application.');
      return this.updateFeishu({
        feishuAppId: config.appId.trim(), feishuAllowedUserId: config.allowedUserId.trim(),
        ...(config.appSecret?.trim() ? { feishuAppSecret: encryptSecret(config.appSecret.trim()) } : {}),
        feishuEnabled: true, feishuStatus: 'connecting', feishuLastError: null,
      });
    }
    const config = input?.wechat;
    if (!config?.allowedUserId?.trim()) throw new BadRequestException('The WeChat allowed user id is required.');
    return this.updateWechat({ wechatAllowedUserId: config.allowedUserId.trim() });
  }

  async feishuSecret() {
    const row = await this.requireChannel(FEISHU_CHANNEL_ID);
    return { ...row, appSecret: row.feishuAppSecret ? decryptSecret(row.feishuAppSecret) : null };
  }

  async updateFeishu(patch: Partial<typeof chatChannels.$inferInsert>): Promise<ChatChannelConfigurationView> {
    await this.db.update(chatChannels).set({ ...patch, updatedAt: new Date() }).where(eq(chatChannels.id, FEISHU_CHANNEL_ID));
    return this.get(FEISHU_CHANNEL_ID);
  }

  async wechatSecret() {
    const row = await this.requireChannel(WECHAT_CHANNEL_ID);
    return { ...row, botToken: row.wechatBotToken ? decryptSecret(row.wechatBotToken) : null };
  }

  async updateWechat(patch: Partial<typeof chatChannels.$inferInsert>): Promise<ChatChannelConfigurationView> {
    await this.db.update(chatChannels).set({ ...patch, updatedAt: new Date() }).where(eq(chatChannels.id, WECHAT_CHANNEL_ID));
    return this.get(WECHAT_CHANNEL_ID);
  }

  private async requireChannel(channelId: string) {
    if (channelId !== FEISHU_CHANNEL_ID && channelId !== WECHAT_CHANNEL_ID) throw new NotFoundException('Chat channel not found.');
    const [row] = await this.db.select().from(chatChannels).where(eq(chatChannels.id, channelId)).limit(1);
    if (!row) throw new NotFoundException('Chat channel not found.');
    return row;
  }
}
