import { Module } from '@nestjs/common';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';

@Module({
  providers: [AgentTeamOperationJournalService],
  exports: [AgentTeamOperationJournalService],
})
export class AgentTeamsModule {}
