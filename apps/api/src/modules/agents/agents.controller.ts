import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ContinueAgentExecutionRequest, CreateAgentExecutionRequest, CreateAgentRequest, UpdateAgentRequest } from '@worklite/contracts';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentsService } from './agents.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService, private readonly executions: AgentExecutionsService) {}

  @Get()
  list(@Req() request: Request) {
    return this.agents.list(request, 'personal');
  }

  @Get(':agentId')
  get(@Req() request: Request, @Param('agentId') agentId: string) {
    return this.agents.get(request, 'personal', agentId);
  }

  @Post()
  create(@Req() request: Request, @Body() body: CreateAgentRequest) {
    return this.agents.create(request, 'personal', body);
  }

  @Post(':agentId/executions')
  createExecution(@Req() request: Request, @Param('agentId') agentId: string, @Body() body: CreateAgentExecutionRequest) {
    return this.executions.create(request, 'personal', agentId, body);
  }

  @Get(':agentId/executions/:executionId')
  getExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.get(request, 'personal', agentId, executionId);
  }

  @Post(':agentId/executions/:executionId/messages')
  continueExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Body() body: ContinueAgentExecutionRequest) {
    return this.executions.continue(request, 'personal', agentId, executionId, body);
  }

  @Post(':agentId/executions/:executionId/cancel')
  cancelExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.cancel(request, 'personal', agentId, executionId);
  }

  @Patch(':agentId')
  update(@Req() request: Request, @Param('agentId') agentId: string, @Body() body: UpdateAgentRequest) {
    return this.agents.update(request, 'personal', agentId, body);
  }

  @Delete(':agentId')
  delete(@Req() request: Request, @Param('agentId') agentId: string) {
    return this.agents.delete(request, 'personal', agentId);
  }
}
