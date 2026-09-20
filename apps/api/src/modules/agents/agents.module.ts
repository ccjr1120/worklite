import { forwardRef, Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { CommandsModule } from '../commands/commands.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentExecutionsService } from './agent-executions.service';
import { McpRuntimeService } from './mcp-runtime.service';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { PluginsModule } from '../plugins/plugins.module';

@Module({ imports: [WorkspaceModule, SkillsModule, CommandsModule, McpServersModule, forwardRef(() => PluginsModule)], controllers: [AgentsController], providers: [AgentsService, AgentExecutionsService, McpRuntimeService, BuiltinAgentToolsService], exports: [AgentsService, AgentExecutionsService] })
export class AgentsModule {}
