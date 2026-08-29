import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateScheduledAgentTaskRequest } from '@worklite/contracts';
import { AgentScheduledTasksService } from './agent-scheduled-tasks.service';

@Controller('agent-scheduled-tasks')
export class AgentScheduledTasksController {
  constructor(private readonly tasks: AgentScheduledTasksService) {}

  @Get()
  list(@Req() request: Request) {
    return this.tasks.list(request, 'personal');
  }

  @Post()
  create(@Req() request: Request, @Body() body: CreateScheduledAgentTaskRequest) {
    return this.tasks.create(request, 'personal', body);
  }

  @Delete(':taskId')
  @HttpCode(204)
  remove(@Req() request: Request, @Param('taskId') taskId: string) {
    return this.tasks.remove(request, 'personal', taskId);
  }
}
