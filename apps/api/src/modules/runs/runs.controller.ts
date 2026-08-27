import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateRunRequest } from '@worklite/contracts';
import { RunsService } from './runs.service';

@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('runs')
  list(@Req() request: Request) {
    return this.runs.list(request, 'personal');
  }

  @Get('runs/:runId')
  get(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.get(request, 'personal', runId);
  }

  @Post('workflows/:workflowId/runs')
  create(@Req() request: Request, @Param('workflowId') workflowId: string, @Body() body: CreateRunRequest) {
    return this.runs.create(request, 'personal', workflowId, body);
  }

  @Post('workflow-versions/:workflowVersionId/runs')
  createForVersion(@Req() request: Request, @Param('workflowVersionId') workflowVersionId: string, @Body() body: CreateRunRequest) {
    return this.runs.createForVersion(request, workflowVersionId, body);
  }

  @Post('runs/:runId/cancel')
  cancel(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.cancel(request, 'personal', runId);
  }
}
