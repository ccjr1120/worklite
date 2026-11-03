import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { UpdatePluginRequest } from '@worklite/contracts';
import { PluginsService } from './plugins.service';
import { WechatOfficialAccountService } from './wechat-official-account.service';
import { WechatService } from './wechat/wechat.service';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService, private readonly officialAccount: WechatOfficialAccountService, private readonly wechat: WechatService) {}

  @Get()
  list() {
    return this.plugins.list();
  }

  @Get(':pluginId')
  get(@Param('pluginId') pluginId: string) {
    return this.plugins.get(pluginId);
  }

  @Patch(':pluginId')
  async update(@Param('pluginId') pluginId: string, @Body() body: UpdatePluginRequest) {
    const saved = await this.plugins.update(pluginId, body);
    if (pluginId === 'wechat-bot') {
      await this.wechat.connect();
      return this.plugins.get(pluginId);
    }
    return saved;
  }

  @Post(':pluginId/test')
  test(@Param('pluginId') pluginId: string) {
    return this.plugins.test(pluginId);
  }

  @Post(':pluginId/official-account/login')
  startOfficialAccountLogin(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'wechat-official-account') throw new BadRequestException('Official Account login is only available for the WeChat Official Account plugin.');
    return this.officialAccount.startAccountLogin();
  }

  @Post(':pluginId/official-account/disconnect')
  disconnectOfficialAccount(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'wechat-official-account') throw new BadRequestException('Official Account login is only available for the WeChat Official Account plugin.');
    return this.officialAccount.disconnect();
  }

  @Post(':pluginId/wechat/login')
  startWechatLogin(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'wechat-bot') throw new BadRequestException('QR login is only available for the WeChat channel plugin.');
    return this.wechat.startLogin();
  }

  @Delete(':pluginId/wechat/login')
  async cancelWechatLogin(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'wechat-bot') throw new BadRequestException('QR login is only available for the WeChat channel plugin.');
    await this.wechat.cancelLogin();
    return this.plugins.get(pluginId);
  }

  @Post(':pluginId/wechat/disconnect')
  disconnectWechat(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'wechat-bot') throw new BadRequestException('This plugin has no WeChat connection.');
    return this.wechat.disconnect();
  }
}
