import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamDocumentsService } from './agent-team-documents.service';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';
import {
  AgentTeamDocumentsController,
  AgentTeamsController,
  AgentTeamRunsController,
} from './agent-teams.controller';
import { AgentTeamsService } from './agent-teams.service';

@Module({
  imports: [forwardRef(() => AgentsModule), CommandsModule, WorkspaceModule],
  controllers: [AgentTeamsController, AgentTeamRunsController, AgentTeamDocumentsController],
  providers: [
    AgentTeamDocumentsService,
    AgentTeamOperationJournalService,
    AgentTeamRuntimeService,
    AgentTeamsService,
  ],
  exports: [AgentTeamDocumentsService, AgentTeamOperationJournalService, AgentTeamRuntimeService, AgentTeamsService],
})
export class AgentTeamsModule {}
