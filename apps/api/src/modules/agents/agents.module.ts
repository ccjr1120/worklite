import { forwardRef, Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { CommandsModule } from '../commands/commands.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentExecutionsService } from './agent-executions.service';
import { McpRuntimeService } from './mcp-runtime.service';
import { BuiltinAgentToolsService } from './builtin-agent-tools.service';
import { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { PluginsModule } from '../plugins/plugins.module';
import { ChatProjectTasksService } from './chat-project-tasks.service';
import { ChatMemoriesService } from './chat-memories.service';
import { CodexAppServerService } from './codex-app-server.service';
import { ClaudeCodeService } from './claude-code.service';
import { ProjectExecutorService } from './project-executor.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ChatAttachmentsController } from './chat-attachments.controller';

@Module({ imports: [WorkspaceModule, SkillsModule, CommandsModule, McpServersModule, forwardRef(() => PluginsModule)], controllers: [AgentsController, ChatAttachmentsController], providers: [AgentsService, AgentExecutionsService, McpRuntimeService, BuiltinAgentToolsService, IsolatedAgentInvocationService, CodexAppServerService, ClaudeCodeService, ProjectExecutorService, ChatProjectTasksService, ChatMemoriesService, ChatAttachmentsService], exports: [AgentsService, AgentExecutionsService, IsolatedAgentInvocationService, ProjectExecutorService, ChatProjectTasksService, ChatMemoriesService] })
export class AgentsModule {}
