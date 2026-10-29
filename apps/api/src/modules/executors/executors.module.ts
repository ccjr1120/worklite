import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentTeamDocumentsService } from './executor-documents.service';
import { AgentTeamOperationJournalService } from './executor-operation-journal.service';
import { AgentTeamConfigurationService } from './executor-configuration.service';
import { AgentTeamManagerToolsService } from './executor-manager-tools.service';
import { AgentTeamMemoryToolsService } from './executor-memory-tools.service';
import { AgentTeamRuntimeService } from './executor-runtime.service';
import { AgentTeamGroupsService } from './executor-groups.service';
import { TeamMemoryService } from './executor-memory.service';
import { TeamMemoryMcpTokenService } from './executor-memory-mcp-token.service';
import { TeamMemoryMcpController } from './executor-memory-mcp.controller';
import {
  ExecutorDocumentsController,
  ExecutorGroupsController,
  ExecutorsController,
  ExecutorRunsController,
} from './executors.controller';
import { ExecutorsService } from './executors.service';

@Module({
  imports: [forwardRef(() => AgentsModule), CommandsModule, WorkspaceModule],
  controllers: [ExecutorsController, ExecutorGroupsController, ExecutorRunsController, ExecutorDocumentsController, TeamMemoryMcpController],
  providers: [
    AgentTeamDocumentsService,
    AgentTeamConfigurationService,
    AgentTeamManagerToolsService,
    AgentTeamMemoryToolsService,
    AgentTeamOperationJournalService,
    AgentTeamRuntimeService,
    ExecutorsService,
    AgentTeamGroupsService,
    TeamMemoryService,
    TeamMemoryMcpTokenService,
  ],
  exports: [AgentTeamDocumentsService, AgentTeamConfigurationService, AgentTeamManagerToolsService, AgentTeamMemoryToolsService, AgentTeamOperationJournalService, AgentTeamRuntimeService, ExecutorsService, AgentTeamGroupsService, TeamMemoryService, TeamMemoryMcpTokenService],
})
export class ExecutorsModule {}
