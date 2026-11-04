import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from './agents.module';
import { WorkspaceModule } from '../teams/teams.module';
import { ChatDispatchService } from './chat-dispatch.service';
import { ChatDispatchController } from './chat-dispatch.controller';
import { ChatConversationsService } from './chat-conversations.service';

@Module({
  imports: [WorkspaceModule, forwardRef(() => AgentsModule)],
  providers: [ChatDispatchService, ChatConversationsService], controllers: [ChatDispatchController], exports: [ChatDispatchService],
})
export class ChatDispatchModule {}
