import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ApplyWorkflowDraftOperationsRequest, CreateWorkflowRequest, ImportWorkflowRequest, ReplaceWorkflowDraftAgentModelsRequest } from '@worklite/contracts';
import { WorkflowSchedulesService } from './workflow-schedules.service';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService, private readonly schedules: WorkflowSchedulesService) {}

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

  @Post('import')
  importWorkflow(@Req() request: Request, @Body() body: ImportWorkflowRequest) {
    return this.workflows.importWorkflow(request, 'personal', body);
  }

  @Get(':workflowId/export')
  exportWorkflow(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.workflows.exportWorkflow(request, 'personal', workflowId);
  }

  @Patch(':workflowId')
  update(@Req() request: Request, @Param('workflowId') workflowId: string, @Body() body: Partial<CreateWorkflowRequest>) {
    return this.workflows.update(request, 'personal', workflowId, body);
  }

  @Delete(':workflowId')
  delete(@Req() request: Request, @Param('workflowId') workflowId: string, @Query('force') force?: string) {
    return this.workflows.delete(request, 'personal', workflowId, { force: force === 'true' });
  }

  @Get(':workflowId/schedule')
  getSchedule(@Req() request: Request, @Param('workflowId') workflowId: string) {
    return this.schedules.get(request, workflowId);
  }

  @Post(':workflowId/draft/operations')
  applyOperations(@Req() request: Request, @Param('workflowId') workflowId: string, @Body() body: ApplyWorkflowDraftOperationsRequest) {
    return this.workflows.applyOperations(request, 'personal', workflowId, body);
  }

  @Post(':workflowId/draft/model-replacement')
  replaceDraftAgentModels(@Req() request: Request, @Param('workflowId') workflowId: string, @Body() body: ReplaceWorkflowDraftAgentModelsRequest) {
    return this.workflows.replaceDraftAgentModels(request, 'personal', workflowId, body);
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
