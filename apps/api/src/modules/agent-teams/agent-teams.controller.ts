import { BadRequestException, Body, Controller, Get, Header, Headers, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  AgentTeamRunEvent,
  AnswerAgentTeamRunRequest,
  RecoverAgentTeamOperationRequest,
  UpdateAgentTeamRequest,
} from '@worklite/contracts';
import { AgentTeamDocumentsService } from './agent-team-documents.service';
import { AgentTeamsService } from './agent-teams.service';

@Controller('agent-teams')
export class AgentTeamsController {
  constructor(
    private readonly teams: AgentTeamsService,
  ) {}

  @Get(':teamId')
  get(@Req() request: Request, @Param('teamId') teamId: string) {
    return this.teams.get(request, 'personal', teamId);
  }

  @Patch(':teamId')
  update(@Req() request: Request, @Param('teamId') teamId: string, @Body() body: UpdateAgentTeamRequest) {
    return this.teams.update(request, 'personal', teamId, body);
  }

  @Get(':teamId/runs')
  records(@Req() request: Request, @Param('teamId') teamId: string) {
    return this.teams.records(request, 'personal', teamId);
  }
}

@Controller('agent-team-runs')
export class AgentTeamRunsController {
  constructor(private readonly teams: AgentTeamsService) {}

  @Get(':runId')
  get(@Req() request: Request, @Param('runId') runId: string) {
    return this.teams.getRun(request, 'personal', runId);
  }

  @Get(':runId/events')
  @Header('Cache-Control', 'no-cache, no-transform')
  async events(
    @Req() request: Request,
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const afterSequence = parseLastEventId(lastEventId);
    await this.teams.getRun(request, 'personal', runId);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let lastSequence = afterSequence;
    let replaying = true;
    let closed = false;
    const pending: AgentTeamRunEvent[] = [];
    const send = (event: AgentTeamRunEvent) => {
      if (closed || event.runId !== runId || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = this.teams.subscribe((event) => {
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
    const replay = await this.teams.events(request, 'personal', runId, afterSequence);
    replay.forEach(send);
    replaying = false;
    pending.sort((left, right) => left.sequence - right.sequence).forEach(send);
    const latest = await this.teams.getRun(request, 'personal', runId);
    if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'cancelled') {
      cleanup();
      response.end();
    }
  }

  @Post(':runId/answer')
  answer(@Req() request: Request, @Param('runId') runId: string, @Body() body: AnswerAgentTeamRunRequest) {
    return this.teams.answer(request, 'personal', runId, body).then((run) => ({ run }));
  }

  @Post(':runId/operations/:operationKey/recovery')
  recover(
    @Req() request: Request,
    @Param('runId') runId: string,
    @Param('operationKey') operationKey: string,
    @Body() body: RecoverAgentTeamOperationRequest,
  ) {
    if (body?.operationKey !== operationKey) {
      throw new BadRequestException('The operation key in the path and body must match.');
    }
    return this.teams.recover(request, 'personal', runId, body).then((run) => ({ run }));
  }

  @Post(':runId/pause')
  pause(@Req() request: Request, @Param('runId') runId: string) {
    return this.teams.pause(request, 'personal', runId).then((run) => ({ run }));
  }

  @Post(':runId/resume')
  resume(@Req() request: Request, @Param('runId') runId: string) {
    return this.teams.resume(request, 'personal', runId).then((run) => ({ run }));
  }

  @Post(':runId/cancel')
  cancel(@Req() request: Request, @Param('runId') runId: string) {
    return this.teams.cancel(request, 'personal', runId).then((run) => ({ run }));
  }

  @Post(':runId/tasks/:taskKey/retry')
  retry(@Req() request: Request, @Param('runId') runId: string, @Param('taskKey') taskKey: string) {
    return this.teams.retry(request, 'personal', runId, taskKey).then((run) => ({ run }));
  }
}

@Controller('agent-team-documents')
export class AgentTeamDocumentsController {
  constructor(private readonly documents: AgentTeamDocumentsService) {}

  @Get(':documentId')
  get(@Req() request: Request, @Param('documentId') documentId: string) {
    return this.documents.getDocument(request, 'personal', documentId);
  }

  @Get(':documentId/download')
  async download(
    @Req() request: Request,
    @Param('documentId') documentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const document = await this.documents.downloadDocument(request, 'personal', documentId);
    response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${document.fileName}"`);
    response.send(document.content);
  }
}

function parseLastEventId(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
