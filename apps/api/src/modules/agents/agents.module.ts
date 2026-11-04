import { forwardRef, Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { CommandsModule } from '../commands/commands.module';
import { AgentRuntimeService } from './agent-runtime.service';
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
import { ChatHostCommandService } from './chat-host-command.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({ imports: [WorkspaceModule, SkillsModule, CommandsModule, McpServersModule, NotificationsModule, forwardRef(() => PluginsModule)], controllers: [AgentsController, ChatAttachmentsController], providers: [AgentRuntimeService, AgentsService, AgentExecutionsService, McpRuntimeService, BuiltinAgentToolsService, IsolatedAgentInvocationService, CodexAppServerService, ClaudeCodeService, ProjectExecutorService, ChatProjectTasksService, ChatMemoriesService, ChatAttachmentsService, ChatHostCommandService], exports: [AgentRuntimeService, AgentsService, AgentExecutionsService, IsolatedAgentInvocationService, ProjectExecutorService, ChatProjectTasksService, ChatMemoriesService, ChatAttachmentsService] })
export class AgentsModule {}
