import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';
import { AgentTeamsController, AgentTeamRunsController } from './agent-teams.controller';
import { AgentTeamsService } from './agent-teams.service';

@Module({
  imports: [AgentsModule, CommandsModule, WorkspaceModule],
  controllers: [AgentTeamsController, AgentTeamRunsController],
  providers: [AgentTeamOperationJournalService, AgentTeamRuntimeService, AgentTeamsService],
  exports: [AgentTeamOperationJournalService, AgentTeamRuntimeService, AgentTeamsService],
})
export class AgentTeamsModule {}
