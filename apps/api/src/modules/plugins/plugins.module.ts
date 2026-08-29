import { forwardRef, Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { WechatClawbotService } from './wechat-clawbot.service';
import { AgentsModule } from '../agents/agents.module';

@Module({ imports: [forwardRef(() => AgentsModule)], controllers: [PluginsController], providers: [PluginsService, WechatClawbotService], exports: [PluginsService, WechatClawbotService] })
export class PluginsModule {}
