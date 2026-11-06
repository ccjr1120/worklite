import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { UpdateChatChannelRequest } from '@worklite/contracts';
import { ChatChannelConfigurationService } from './chat-channel-configuration.service';
import { WechatService } from './wechat/wechat.service';

@Controller('chat/channels')
export class ChatChannelConfigurationController {
  constructor(private readonly configuration: ChatChannelConfigurationService, private readonly wechat: WechatService) {}

  @Get(':channelId')
  get(@Param('channelId') channelId: string) {
    this.requireWechat(channelId);
    return this.configuration.get(channelId);
  }

  @Patch(':channelId')
  async update(@Param('channelId') channelId: string, @Body() body: UpdateChatChannelRequest) {
    // Feishu is retained as stored history, but is not an enabled Chat transport.
    this.requireWechat(channelId);
    await this.configuration.update(channelId, body);
    await this.wechat.connect();
    return this.configuration.get(channelId);
  }

  @Post(':channelId/login')
  startLogin(@Param('channelId') channelId: string) {
    this.requireWechat(channelId);
    return this.wechat.startLogin();
  }

  @Delete(':channelId/login')
  async cancelLogin(@Param('channelId') channelId: string) {
    this.requireWechat(channelId);
    await this.wechat.cancelLogin();
    return this.configuration.get(channelId);
  }

  @Post(':channelId/disconnect')
  disconnect(@Param('channelId') channelId: string) {
    this.requireWechat(channelId);
    return this.wechat.disconnect();
  }

  private requireWechat(channelId: string) {
    if (channelId !== 'wechat') throw new BadRequestException('This Chat channel is not configurable.');
  }
}
