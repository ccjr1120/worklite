import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from './agents.module';
import { WorkspaceModule } from '../teams/teams.module';
import { ChatDispatchService } from './chat-dispatch.service';
import { ChatDispatchController } from './chat-dispatch.controller';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatSuggestionsService } from './chat-suggestions.service';
import { ModelProvidersModule } from '../model-providers/model-providers.module';

@Module({
  imports: [WorkspaceModule, ModelProvidersModule, forwardRef(() => AgentsModule)],
  providers: [ChatDispatchService, ChatConversationsService, ChatSuggestionsService], controllers: [ChatDispatchController], exports: [ChatDispatchService],
})
export class ChatDispatchModule {}
