import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ApplyWorkflowDraftOperationsRequest, CreateWorkflowRequest } from '@worklite/contracts';
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

  @Post(':workflowId/draft/operations')
  applyOperations(@Req() request: Request, @Param('workflowId') workflowId: string, @Body() body: ApplyWorkflowDraftOperationsRequest) {
    return this.workflows.applyOperations(request, 'personal', workflowId, body);
  }

  @Post(':workflowId/draft/undo')
  undo(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.workflows.undo(request, 'personal', workflowId);
  }

  @Post(':workflowId/draft/redo')
  redo(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.workflows.redo(request, 'personal', workflowId);
  }

  @Post(':workflowId/publish')
  publish(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.workflows.publish(request, 'personal', workflowId);
  }

  @Get(':workflowId/versions')
  versions(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.workflows.versions(request, 'personal', workflowId);
  }
}
