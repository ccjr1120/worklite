import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { CommandsModule } from '../commands/commands.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentSubSessionsController } from './agent-sub-sessions.controller';
import { AgentSubSessionsService } from './agent-sub-sessions.service';
import { McpRuntimeService } from './mcp-runtime.service';
import { AgentScheduledTasksController } from './agent-scheduled-tasks.controller';
import { AgentScheduledTasksService } from './agent-scheduled-tasks.service';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';

@Module({ imports: [WorkspaceModule, SkillsModule, CommandsModule], controllers: [AgentsController, AgentSubSessionsController, AgentScheduledTasksController], providers: [AgentsService, AgentExecutionsService, AgentSubSessionsService, McpRuntimeService, AgentScheduledTasksService, BuiltinAgentToolsService] })
export class AgentsModule {}
