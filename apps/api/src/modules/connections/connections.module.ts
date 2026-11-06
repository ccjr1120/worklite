import { forwardRef, Module } from '@nestjs/common';
import { ChatChannelConfigurationController } from './chat-channel-configuration.controller';
import { ChatChannelConfigurationService } from './chat-channel-configuration.service';
import { AgentOfficialAccountController } from './agent-official-account.controller';
import { ChatDispatchModule } from '../agents/chat-dispatch.module';
import { WechatOfficialAccountService } from './wechat-official-account.service';
import { WechatService } from './wechat/wechat.service';
import { AgentsModule } from '../agents/agents.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { WorkspaceModule } from '../teams/teams.module';
import { WechatDraftRevisionService } from './wechat-draft-revision.service';
import { WechatDraftsController } from './wechat-drafts.controller';

@Module({ imports: [ArtifactsModule, WorkspaceModule, forwardRef(() => AgentsModule), forwardRef(() => ChatDispatchModule)], controllers: [ChatChannelConfigurationController, AgentOfficialAccountController, WechatDraftsController], providers: [ChatChannelConfigurationService, WechatOfficialAccountService, WechatDraftRevisionService, WechatService, { provide: 'WECHAT_UPGRADE_TRANSPORT', useExisting: WechatService }], exports: [WechatDraftRevisionService, WechatOfficialAccountService, WechatService] })
export class ConnectionsModule {}
