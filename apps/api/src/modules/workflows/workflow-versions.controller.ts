import { Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { WorkflowsService } from './workflows.service';

@Controller('workflow-versions')
export class WorkflowVersionsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get(':versionId')
  get(@Req() request: Request, @Param('versionId') versionId: string) {
    return this.workflows.version(request, 'personal', versionId);
  }
}
