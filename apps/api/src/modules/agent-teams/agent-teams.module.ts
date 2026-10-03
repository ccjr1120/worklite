import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamConversationService } from './agent-team-conversation.service';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';
import {
  AgentTeamDocumentsController,
  AgentTeamsController,
  AgentTeamRunsController,
} from './agent-teams.controller';
import { AgentTeamsService } from './agent-teams.service';

@Module({
  imports: [AgentsModule, CommandsModule, WorkspaceModule],
  controllers: [AgentTeamsController, AgentTeamRunsController, AgentTeamDocumentsController],
  providers: [
    AgentTeamConversationService,
    AgentTeamOperationJournalService,
    AgentTeamRuntimeService,
    AgentTeamsService,
  ],
  exports: [AgentTeamOperationJournalService, AgentTeamRuntimeService, AgentTeamsService],
})
export class AgentTeamsModule {}
