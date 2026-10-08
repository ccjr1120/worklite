import { Body, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AgentExecutionEvent, AnswerAgentQuestionRequest, ContinueAgentExecutionRequest, CreateAgentExecutionRequest, UpdateAgentRequest } from '@worklite/contracts';
import { AgentExecutionsService } from './agent-executions.service';
import { AgentsService } from './agents.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService, private readonly executions: AgentExecutionsService) {}


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
    if (latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled') {
      cleanup();
      response.end();
    }
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

  @Post(':agentId/executions/:executionId/cancel')
  cancelExecution(@Req() request: Request, @Param('agentId') agentId: string, @Param('executionId') executionId: string) {
    return this.executions.cancel(request, 'personal', agentId, executionId);
  }

  @Patch(':agentId')
  update(@Req() request: Request, @Param('agentId') agentId: string, @Body() body: UpdateAgentRequest) {
    return this.agents.update(request, 'personal', agentId, body);
  }

}

function parseLastEventId(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
