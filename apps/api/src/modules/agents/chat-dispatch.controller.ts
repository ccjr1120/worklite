import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AnswerAgentQuestionRequest, DispatchChatRequest } from '@worklite/contracts';
import { ChatDispatchService } from './chat-dispatch.service';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatProjectTasksService } from './chat-project-tasks.service';
import { AgentExecutionsService } from './agent-executions.service';
import { WorkspaceService } from '../teams/teams.service';

@Controller('chat')
export class ChatDispatchController {
  constructor(private readonly dispatches: ChatDispatchService, private readonly conversations: ChatConversationsService, private readonly projectTasks: ChatProjectTasksService, private readonly executions: AgentExecutionsService, private readonly workspaces: WorkspaceService) {}

  @Get('project-tasks/:id')
  async projectTask(@Req() request: Request, @Param('id') id: string, @Query('operationKey') operationKey?: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    if (operationKey) return this.projectTasks.operation(id, operationKey, workspace.id);
    return this.projectTasks.view(id, workspace.id);
  }

  @Post('project-tasks/:id/answer')
  answerProjectTask(@Req() request: Request, @Param('id') id: string, @Body() input: AnswerAgentQuestionRequest) {
    return this.executions.answerProjectTask(request, 'personal', id, input);
  }

  @Post('project-tasks/:id/cancel')
  cancelProjectTask(@Req() request: Request, @Param('id') id: string) {
    return this.executions.cancelProjectTask(request, 'personal', id);
  }

  @Get('channels')
  channels() { return this.conversations.channels(); }

  @Get('conversations')
  list(@Req() request: Request, @Query() query: { cursor?: string; search?: string; channel?: string }) {
    return this.conversations.list(request, query);
  }

  @Get('conversations/:id')
  get(@Req() request: Request, @Param('id') id: string) { return this.conversations.get(request, id); }

  @Get('conversations/:id/records')
  records(@Req() request: Request, @Param('id') id: string) { return this.conversations.records(request, id); }

  @Post('dispatch')
  dispatch(@Req() request: Request, @Body() input: DispatchChatRequest) {
    return this.dispatches.dispatch(request, input);
  }
}
