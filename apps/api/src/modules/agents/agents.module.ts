import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { CommandsModule } from '../commands/commands.module';
import { AgentsController } from './agents.controller';
import { AgentVersionsController } from './agent-versions.controller';
import { AgentsService } from './agents.service';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentSubSessionsController } from './agent-sub-sessions.controller';
import { AgentSubSessionsService } from './agent-sub-sessions.service';
import { McpRuntimeService } from './mcp-runtime.service';
import { AgentScheduledTasksController } from './agent-scheduled-tasks.controller';
import { AgentScheduledTasksService } from './agent-scheduled-tasks.service';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { PluginsModule } from '../plugins/plugins.module';

@Module({ imports: [WorkspaceModule, SkillsModule, CommandsModule, McpServersModule, PluginsModule], controllers: [AgentsController, AgentVersionsController, AgentSubSessionsController, AgentScheduledTasksController], providers: [AgentsService, AgentExecutionsService, AgentSubSessionsService, McpRuntimeService, AgentScheduledTasksService, BuiltinAgentToolsService], exports: [AgentsService, AgentExecutionsService] })
export class AgentsModule {}
