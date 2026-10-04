import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { UpdatePluginRequest } from '@worklite/contracts';
import { PluginsService } from './plugins.service';
import { FeishuService } from './feishu/feishu.service';
import { FeishuRegistrationService } from './feishu/feishu-registration.service';
import { WechatOfficialAccountService } from './wechat-official-account.service';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService, private readonly feishu: FeishuService, private readonly registration: FeishuRegistrationService, private readonly officialAccount: WechatOfficialAccountService) {}

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
    if (pluginId === 'feishu-bot') await this.registration.cancel();
    const saved = await this.plugins.update(pluginId, body);
    if (pluginId === 'feishu-bot') {
      await this.registration.completeManualBinding();
      await this.feishu.connect();
      return this.plugins.get(pluginId);
    }
    return saved;
  }

  @Post(':pluginId/test')
  test(@Param('pluginId') pluginId: string) {
    return this.plugins.test(pluginId);
  }

  @Post(':pluginId/feishu/disconnect')
  async disconnectFeishu(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'feishu-bot') throw new BadRequestException('This plugin has no Feishu connection.');
    await this.registration.cancel();
    return this.feishu.disconnect();
  }

  @Post(':pluginId/feishu/registration')
  startFeishuRegistration(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'feishu-bot') throw new BadRequestException('This plugin has no Feishu registration.');
    return this.registration.start();
  }

  @Delete(':pluginId/feishu/registration')
  async cancelFeishuRegistration(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'feishu-bot') throw new BadRequestException('This plugin has no Feishu registration.');
    await this.registration.cancel();
    return this.plugins.get(pluginId);
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
}
