import { Body, Controller, Get, Header, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CreateRunRequest, RunProgressEvent } from '@worklite/contracts';
import { RunsService } from './runs.service';

@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('runs')
  list(@Req() request: Request, @Query('workflowId') workflowId?: string, @Query('limit') limit?: string) {
    // Read-only filters keep a Workflow inspection bounded instead of loading every workspace Run.
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return this.runs.list(request, 'personal', {
      workflowId: workflowId?.trim() || undefined,
      limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : undefined,
    });
  }

  @Get('runs/:runId')
  get(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.get(request, 'personal', runId);
  }

  @Get('runs/:runId/events')
  @Header('Cache-Control', 'no-cache, no-transform')
  async events(@Req() request: Request, @Param('runId') runId: string, @Headers('last-event-id') lastEventId: string | undefined, @Res() response: Response): Promise<void> {
    const afterSequence = parseLastEventId(lastEventId);
    await this.runs.get(request, 'personal', runId);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let lastSequence = afterSequence;
    let replaying = true;
    let closed = false;
    const pending: RunProgressEvent[] = [];
    const send = (event: RunProgressEvent) => {
      if (closed || event.runId !== runId || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = this.runs.subscribe((event) => {
      if (event.runId !== runId) return;
      if (replaying) pending.push(event);
      else send(event);
    });
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.once('close', cleanup);
    const replay = await this.runs.events(request, 'personal', runId, afterSequence);
    replay.forEach(send);
    replaying = false;
    pending.sort((left, right) => left.sequence - right.sequence).forEach(send);
    const latest = await this.runs.get(request, 'personal', runId);
    if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'timed_out') {
      cleanup();
      response.end();
    }
  }

  @Post('workflow-versions/:workflowVersionId/runs')
  createForVersion(@Req() request: Request, @Param('workflowVersionId') workflowVersionId: string, @Body() body: CreateRunRequest) {
    return this.runs.createForVersion(request, workflowVersionId, body);
  }

  @Post('runs/:runId/cancel')
  cancel(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.cancel(request, 'personal', runId);
  }

  @Post('runs/:runId/pause')
  pause(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.pause(request, 'personal', runId);
  }

  @Post('runs/:runId/resume')
  resume(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.resume(request, 'personal', runId);
  }

  @Post('runs/:runId/pending-action/refresh')
  refreshPendingAction(@Req() request: Request, @Param('runId') runId: string) {
    return this.runs.refreshPendingAction(request, 'personal', runId);
  }

  @Post('runs/:runId/nodes/:nodeRunId/retry')
  retryNode(@Req() request: Request, @Param('runId') runId: string, @Param('nodeRunId') nodeRunId: string) {
    return this.runs.retryNode(request, 'personal', runId, nodeRunId);
  }
}

function parseLastEventId(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
