import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from './agents.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamsModule } from '../agent-teams/agent-teams.module';
import { RunsModule } from '../runs/runs.module';
import { ChatDispatchService } from './chat-dispatch.service';
import { ChatDispatchController } from './chat-dispatch.controller';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatTeamRunReportsService } from './chat-team-run-reports.service';

@Module({
  imports: [WorkspaceModule, forwardRef(() => AgentsModule), forwardRef(() => AgentTeamsModule), forwardRef(() => RunsModule)],
  providers: [ChatDispatchService, ChatConversationsService, ChatTeamRunReportsService], controllers: [ChatDispatchController], exports: [ChatDispatchService],
})
export class ChatDispatchModule {}
