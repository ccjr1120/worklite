import { forwardRef, Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { FeishuService } from './feishu/feishu.service';
import { FeishuRegistrationService } from './feishu/feishu-registration.service';
import { ChatDispatchModule } from '../agents/chat-dispatch.module';
import { AgentTeamsModule } from '../executor-categories/executor-categories.module';
import { RunsModule } from '../runs/runs.module';
import { WechatOfficialAccountService } from './wechat-official-account.service';
import { WechatService } from './wechat/wechat.service';
import { AgentsModule } from '../agents/agents.module';

@Module({ imports: [forwardRef(() => AgentsModule), forwardRef(() => ChatDispatchModule), forwardRef(() => AgentTeamsModule), forwardRef(() => RunsModule)], controllers: [PluginsController], providers: [PluginsService, FeishuService, FeishuRegistrationService, { provide: 'FEISHU_UPGRADE_TRANSPORT', useExisting: FeishuService }, { provide: 'FEISHU_REGISTRATION_RUNTIME', useExisting: FeishuRegistrationService }, WechatOfficialAccountService, WechatService, { provide: 'WECHAT_UPGRADE_TRANSPORT', useExisting: WechatService }], exports: [PluginsService, FeishuService, WechatOfficialAccountService, WechatService] })
export class PluginsModule {}
