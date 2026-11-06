import { AgentHistoryService } from './agent-history.service';
import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AgentExecutionEvent, CreateAgentRequest, AnswerAgentQuestionRequest, ContinueAgentExecutionRequest, CreateAgentExecutionRequest, UpdateAgentRequest } from '@worklite/contracts';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentsService } from './agents.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService, private readonly executions: AgentExecutionsService, private readonly history: AgentHistoryService) {}


  @Get()
  list(@Req() request: Request) { return this.agents.list(request, 'personal'); }

  @Post()
  create(@Req() request: Request, @Body() body: CreateAgentRequest) { return this.agents.create(request, 'personal', body); }

  @Get('run-usage/:runId')
  runUsage(@Req() request: Request, @Param('runId') runId: string) {
    return this.history.usage(request, runId);
  }

  @Post(':agentId/executions/:executionId/steer')
  steer(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Body() body: ContinueAgentExecutionRequest) {
    return this.executions.steerRuntimeSession(request, 'personal', agentId, executionId, body);
  }

  @Delete(':agentId/executions/:executionId/session')
  closeSession(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.closeRuntimeSession(request, 'personal', agentId, executionId);
  }

  @Get(':agentId/history')
  listHistory(@Req() request: Request, @Param('agentId') agentId: string, @Query('offset') offset?: string) {
    const parsed = Number(offset ?? 0);
    return this.history.list(request, agentId, Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, 10000) : 0);
  }

  @Get(':agentId/history/:runId')
  getHistory(@Req() request: Request, @Param('agentId') agentId: string, @Param('runId') runId: string) {
    return this.history.detail(request, agentId, runId);
  }

  @Get(':agentId/sub-agents')
  children(@Req() request: Request, @Param('agentId') agentId: string) { return this.agents.children(request, 'personal', agentId); }

  @Post(':agentId/sub-agents')
  createChild(@Req() request: Request, @Param('agentId') agentId: string, @Body() body: CreateAgentRequest) { return this.agents.create(request, 'personal', { ...body, parentAgentId: agentId }); }

  @Get(':agentId/sub-agents/:childId')
  child(@Req() request: Request, @Param('agentId') agentId: string, @Param('childId') childId: string) { return this.agents.get(request, 'personal', childId, agentId); }

  @Patch(':agentId/sub-agents/:childId')
  updateChild(@Req() request: Request, @Param('agentId') agentId: string, @Param('childId') childId: string, @Body() body: UpdateAgentRequest) { return this.agents.update(request, 'personal', childId, { ...body, parentAgentId: agentId }); }

  @Delete(':agentId/sub-agents/:childId')
  deleteChild(@Req() request: Request, @Param('agentId') agentId: string, @Param('childId') childId: string) { return this.agents.delete(request, 'personal', childId, agentId); }

  @Get(':agentId')
  get(@Req() request: Request, @Param('agentId') agentId: string) {
    return this.agents.get(request, 'personal', agentId);
  }




  @Post(':agentId/executions')
  createExecution(@Req() request: Request, @Param('agentId') agentId: string, @Body() body: CreateAgentExecutionRequest) {
    return this.executions.create(request, 'personal', agentId, body);
  }

  @Get(':agentId/executions/:executionId')
  getExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.get(request, 'personal', agentId, executionId);
  }

  @Get(':agentId/executions/:executionId/events')
  @Header('Cache-Control', 'no-cache, no-transform')
  async executionEvents(
    @Req() request: Request,
    @Param('agentId') agentId: string,
    @Param('executionId') executionId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const afterSequence = parseLastEventId(lastEventId);
    const execution = await this.executions.get(request, 'personal', agentId, executionId);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let lastSequence = afterSequence;
    let replaying = true;
    let closed = false;
    const pending: AgentExecutionEvent[] = [];
    const send = (event: AgentExecutionEvent) => {
      if (closed || event.executionId !== executionId || (event.sequence > 0 && event.sequence <= lastSequence)) return;
      if (event.sequence > 0) lastSequence = event.sequence;
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = this.executions.subscribe((event) => {
      if (event.executionId !== executionId) return;
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
    const events = await this.executions.events(request, 'personal', agentId, executionId, afterSequence);
    // A new observer needs current state and the uncommitted deltas after it,
    // rather than every status transition from previous conversation turns.
    let latestSnapshotIndex = -1;
    if (afterSequence === 0) {
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index].data.kind === 'snapshot') { latestSnapshotIndex = index; break; }
      }
    }
    const replay = latestSnapshotIndex >= 0 ? events.slice(latestSnapshotIndex) : events;
    replay.forEach(send);
    replaying = false;
    pending.sort((left, right) => left.sequence - right.sequence).forEach(send);
    const hasSnapshot = [...replay, ...pending].some((event) => event.data.kind === 'snapshot');
    if (!hasSnapshot && afterSequence === 0) {
      send({ sequence: 0, executionId, data: { kind: 'snapshot', execution }, createdAt: new Date().toISOString() });
    }
    const latest = await this.executions.get(request, 'personal', agentId, executionId);
    // Background project tasks outlive the turn; keep delivering their progress and the
    // automatic report turn, matching the browser's observation rule.
    const activeProjectTasks = latest.toolCalls.some((call) => call.projectTask && (call.projectTask.status === 'running' || call.projectTask.status === 'waiting_for_input'));
    if ((latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled') && !activeProjectTasks) {
      cleanup();
      response.end();
    }
  }

  @Get(':agentId/executions/:executionId/history-archives/:resultRef')
  historyArchive(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Param('resultRef') resultRef: string, @Query('offset') offset?: string, @Query('maxChars') maxChars?: string) {
    return this.executions.readHistoryArchive(request, 'personal', agentId, executionId, resultRef, offset === undefined ? 0 : Number(offset), maxChars === undefined ? 12000 : Number(maxChars));
  }

  @Post(':agentId/executions/:executionId/messages')
  continueExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Body() body: ContinueAgentExecutionRequest) {
    return this.executions.continue(request, 'personal', agentId, executionId, body);
  }

  @Post(':agentId/executions/:executionId/answers')
  answerQuestion(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Body() body: AnswerAgentQuestionRequest) {
    return this.executions.answer(request, 'personal', agentId, executionId, body);
  }

  @Post(':agentId/executions/:executionId/retry')
  retryExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.retry(request, 'personal', agentId, executionId);
  }

  @Post(':agentId/executions/:executionId/sub-agents/:runId/pause')
  pauseSubAgent(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Param('runId') runId: string) {
    return this.executions.controlSubAgent(request, 'personal', agentId, executionId, runId, 'pause');
  }

  @Post(':agentId/executions/:executionId/sub-agents/:runId/resume')
  resumeSubAgent(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string, @Param('runId') runId: string) {
    return this.executions.controlSubAgent(request, 'personal', agentId, executionId, runId, 'resume');
  }

  @Post(':agentId/executions/:executionId/cancel')
  cancelExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.cancel(request, 'personal', agentId, executionId);
  }

  @Delete(':agentId')
  delete(@Req() request: Request, @Param('agentId') agentId: string) { return this.agents.delete(request, 'personal', agentId); }

  @Patch(':agentId')
  update(@Req() request: Request, @Param('agentId') agentId: string, @Body() body: UpdateAgentRequest) {
    if (body.parentAgentId !== undefined) throw new BadRequestException('Use PATCH /agents/:parentId/sub-agents/:childId to update a private sub-Agent.');
    return this.agents.update(request, 'personal', agentId, body);
  }

}

function parseLastEventId(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
