import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateWorkflowRequest } from '@worklite/contracts';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@Req() request: Request) {
    return this.workflows.list(request, 'personal');
  }

  @Get(':workflowId')
  get(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.workflows.get(request, 'personal', workflowId);
  }

  @Post()
  create(@Req() request: Request, @Body() body: CreateWorkflowRequest) {
    return this.workflows.create(request, 'personal', body);
  }

  @Patch(':workflowId')
  update(@Req() request: Request, @Param('workflowId') workflowId: string, @Body() body: Partial<CreateWorkflowRequest>) {
    return this.workflows.update(request, 'personal', workflowId, body);
  }
}
