import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamDocumentsService } from './agent-team-documents.service';
import { AgentTeamOperationJournalService } from './agent-team-operation-journal.service';
import { AgentTeamConfigurationService } from './agent-team-configuration.service';
import { AgentTeamManagerToolsService } from './agent-executor-manager-tools.service';
import { AgentTeamMemoryToolsService } from './agent-team-memory-tools.service';
import { AgentTeamRuntimeService } from './agent-team-runtime.service';
import { AgentTeamGroupsService } from './executor-groups.service';
import { TeamMemoryService } from './team-memory.service';
import { TeamMemoryMcpTokenService } from './team-memory-mcp-token.service';
import { TeamMemoryMcpController } from './team-memory-mcp.controller';
import {
  AgentTeamDocumentsController,
  AgentTeamGroupsController,
  AgentTeamsController,
  AgentTeamRunsController,
} from './executor-categories.controller';
import { AgentTeamsService } from './executor-categories.service';

@Module({
  imports: [forwardRef(() => AgentsModule), CommandsModule, WorkspaceModule],
  controllers: [AgentTeamsController, AgentTeamGroupsController, AgentTeamRunsController, AgentTeamDocumentsController, TeamMemoryMcpController],
  providers: [
    AgentTeamDocumentsService,
    AgentTeamConfigurationService,
    AgentTeamManagerToolsService,
    AgentTeamMemoryToolsService,
    AgentTeamOperationJournalService,
    AgentTeamRuntimeService,
    AgentTeamsService,
    AgentTeamGroupsService,
    TeamMemoryService,
    TeamMemoryMcpTokenService,
  ],
  exports: [AgentTeamDocumentsService, AgentTeamConfigurationService, AgentTeamManagerToolsService, AgentTeamMemoryToolsService, AgentTeamOperationJournalService, AgentTeamRuntimeService, AgentTeamsService, AgentTeamGroupsService, TeamMemoryService, TeamMemoryMcpTokenService],
})
export class AgentTeamsModule {}
