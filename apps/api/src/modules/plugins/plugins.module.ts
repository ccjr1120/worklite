import { forwardRef, Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { ChatDispatchModule } from '../agents/chat-dispatch.module';
import { WechatOfficialAccountService } from './wechat-official-account.service';
import { WechatService } from './wechat/wechat.service';
import { AgentsModule } from '../agents/agents.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { WorkspaceModule } from '../teams/teams.module';
import { WechatDraftRevisionService } from './wechat-draft-revision.service';
import { WechatDraftsController } from './wechat-drafts.controller';

@Module({ imports: [ArtifactsModule, WorkspaceModule, forwardRef(() => AgentsModule), forwardRef(() => ChatDispatchModule)], controllers: [PluginsController, WechatDraftsController], providers: [PluginsService, WechatOfficialAccountService, WechatDraftRevisionService, WechatService, { provide: 'WECHAT_UPGRADE_TRANSPORT', useExisting: WechatService }], exports: [WechatDraftRevisionService, PluginsService, WechatOfficialAccountService, WechatService] })
export class PluginsModule {}
