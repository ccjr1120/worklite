import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { UpdatePluginRequest } from '@worklite/contracts';
import { PluginsService } from './plugins.service';

@Controller('plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

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
}
