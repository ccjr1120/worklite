import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { UpdatePluginRequest } from '@worklite/contracts';
import { PluginsService } from './plugins.service';
import { WechatClawbotService } from './wechat-clawbot.service';
import { WechatOfficialAccountService } from './wechat-official-account.service';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService, private readonly wechat: WechatClawbotService, private readonly officialAccount: WechatOfficialAccountService) {}

  @Get()
  list() {
    return this.plugins.list();
  }

  @Get(':pluginId')
  get(@Param('pluginId') pluginId: string) {
    return this.plugins.get(pluginId);
  }

  @Patch(':pluginId')
  update(@Param('pluginId') pluginId: string, @Body() body: UpdatePluginRequest) {
    return this.plugins.update(pluginId, body);
  }

  @Post(':pluginId/test')
  test(@Param('pluginId') pluginId: string) {
    return this.plugins.test(pluginId);
  }

  @Post(':pluginId/wechat/login')
  startWechatLogin(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'codex-cli-chat') throw new BadRequestException('WeChat transport is only available for the Codex plugin.');
    return this.wechat.startLogin();
  }

  @Post(':pluginId/wechat/disconnect')
  disconnectWechat(@Param('pluginId') pluginId: string) {
    if (pluginId !== 'codex-cli-chat') throw new BadRequestException('WeChat transport is only available for the Codex plugin.');
    return this.wechat.disconnect();
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
