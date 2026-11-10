import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import type { AnswerAgentQuestionRequest, DispatchChatRequest, SaveChatMemoryRequest, SteerProjectTaskRequest, UpdateChatMemoryRequest } from '@worklite/contracts';
import { ChatDispatchService } from './chat-dispatch.service';
import { ChatConversationsService } from './chat-conversations.service';
import { ChatMemoriesService } from './chat-memories.service';
import { ChatProjectTasksService } from './chat-project-tasks.service';
import { AgentExecutionsService } from './agent-executions.service';
import { WorkspaceService } from '../teams/teams.service';
import { ChatSuggestionsService } from './chat-suggestions.service';

@Controller('chat')
export class ChatDispatchController {
  constructor(private readonly dispatches: ChatDispatchService, private readonly conversations: ChatConversationsService, private readonly projectTasks: ChatProjectTasksService, private readonly executions: AgentExecutionsService, private readonly workspaces: WorkspaceService, private readonly memories: ChatMemoriesService, private readonly suggestions: ChatSuggestionsService) {}

  @Get('project-tasks')
  async listProjectTasks(@Req() request: Request, @Query('status') status?: string, @Query('limit') limit?: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const filter = status === 'active' || status === 'settled' ? status : 'all';
    return this.projectTasks.listWorkspace(workspace.id, { status: filter, limit: limit ? Number(limit) : undefined });
  }

  @Post('project-tasks/:id/subscribe')
  async subscribeProjectTask(@Req() request: Request, @Param('id') id: string, @Body() input: { executionId?: string }) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const executionId = typeof input?.executionId === 'string' ? input.executionId.trim() : '';
    if (!executionId) throw new BadRequestException('executionId is required.');
    const result = this.projectTasks.subscribe(workspace.id, id, executionId);
    this.executions.scheduleSettledSubscriptionReports(workspace.id, id);
    return result;
  }

  @Get('project-tasks/:id')
  async projectTask(@Req() request: Request, @Param('id') id: string, @Query('operationKey') operationKey?: string, @Query('activities') activities?: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    if (operationKey) return this.projectTasks.operation(id, operationKey, workspace.id);
    return this.projectTasks.view(id, workspace.id, { activities: activities === 'full' ? 'full' : 'recent' });
  }

  @Post('project-tasks/:id/answer')
  answerProjectTask(@Req() request: Request, @Param('id') id: string, @Body() input: AnswerAgentQuestionRequest) {
    return this.executions.answerProjectTask(request, 'personal', id, input);
  }

  @Post('project-tasks/:id/cancel')
  cancelProjectTask(@Req() request: Request, @Param('id') id: string) {
    return this.executions.cancelProjectTask(request, 'personal', id);
  }

  @Post('project-tasks/:id/steer')
  steerProjectTask(@Req() request: Request, @Param('id') id: string, @Body() input: SteerProjectTaskRequest) {
    const text = typeof input?.text === 'string' ? input.text : '';
    if (!text.trim()) throw new BadRequestException('text is required.');
    return this.executions.steerProjectTask(request, 'personal', id, text);
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

  @Post('conversations/:id/summarize')
  summarize(@Req() request: Request, @Param('id') id: string) { return this.conversations.summarize(request, id); }

  @Post('conversations/:id/suggestions')
  suggest(@Req() request: Request, @Param('id') id: string, @Body() input: { contextVersion?: string }) {
    if (typeof input?.contextVersion !== 'string' || !/^v1-[a-z0-9]+-[a-z0-9]+$/.test(input.contextVersion) || input.contextVersion.length > 40) throw new BadRequestException('Invalid suggestion context version.');
    return this.suggestions.suggest(request, id, input.contextVersion);
  }

  @Post('dispatch')
  dispatch(@Req() request: Request, @Body() input: DispatchChatRequest) {
    return this.dispatches.dispatch(request, input);
  }

  @Get('memories')
  async listMemories(@Req() request: Request, @Query('category') category?: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.memories.list(workspace.id, { category: category as SaveChatMemoryRequest['category'] });
  }

  @Get('memories/:id')
  async getMemory(@Req() request: Request, @Param('id') id: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.memories.get(workspace.id, id);
  }

  @Post('memories')
  async saveMemory(@Req() request: Request, @Body() input: SaveChatMemoryRequest) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.memories.save(workspace.id, input);
  }

  @Patch('memories/:id')
  async updateMemory(@Req() request: Request, @Param('id') id: string, @Body() input: UpdateChatMemoryRequest) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.memories.update(workspace.id, id, input);
  }

  @Delete('memories/:id')
  async deleteMemory(@Req() request: Request, @Param('id') id: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.memories.remove(workspace.id, id);
  }
}
