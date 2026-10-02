import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';

@Module({
  imports: [AgentsModule, WorkspaceModule],
  providers: [AgentTeamOperationJournalService, AgentTeamRuntimeService],
  exports: [AgentTeamOperationJournalService, AgentTeamRuntimeService],
})
export class AgentTeamsModule {}
