import { forwardRef, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { CommandsModule } from '../commands/commands.module';
import { WorkspaceModule } from '../teams/teams.module';
import { ModelProvidersModule } from '../model-providers/model-providers.module';
import { AgentTeamDocumentsService } from './coder-documents.service';
import { AgentTeamOperationJournalService } from './coder-operation-journal.service';
import { AgentTeamConfigurationService } from './coder-configuration.service';
import { AgentTeamMemoryToolsService } from './coder-memory-tools.service';
import { AgentTeamRuntimeService } from './coder-runtime.service';
import { AgentTeamGroupsService } from './coder-groups.service';
import { TeamMemoryService } from './coder-memory.service';
import { TeamMemoryMcpTokenService } from './coder-memory-mcp-token.service';
import { TeamMemoryMcpController } from './coder-memory-mcp.controller';
import {
  CoderDocumentsController,
  CoderGroupsController,
  CodersController,
  CoderRunsController,
} from './coders.controller';
import { CodersService } from './coders.service';

@Module({
  imports: [forwardRef(() => AgentsModule), CommandsModule, WorkspaceModule, ModelProvidersModule],
  controllers: [CodersController, CoderGroupsController, CoderRunsController, CoderDocumentsController, TeamMemoryMcpController],
  providers: [
    AgentTeamDocumentsService,
    AgentTeamConfigurationService,
    AgentTeamMemoryToolsService,
    AgentTeamOperationJournalService,
    AgentTeamRuntimeService,
    CodersService,
    AgentTeamGroupsService,
    TeamMemoryService,
    TeamMemoryMcpTokenService,
  ],
  exports: [AgentTeamDocumentsService, AgentTeamConfigurationService, AgentTeamMemoryToolsService, AgentTeamOperationJournalService, AgentTeamRuntimeService, CodersService, AgentTeamGroupsService, TeamMemoryService, TeamMemoryMcpTokenService],
})
export class CodersModule {}
