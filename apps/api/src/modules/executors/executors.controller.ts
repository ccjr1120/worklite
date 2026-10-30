import { BadRequestException, Body, Controller, Delete, Get, Header, Headers, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  AgentTeamRunEvent,
  AnswerAgentTeamRunRequest,
  AgentTeamGroupControlRequest,
  AgentTeamGroupEvent,
  CreateAgentTeamMemoryRequest,
  RecoverAgentTeamOperationRequest,
  UpdateAgentTeamRequest,
  AgentTeamRoleConfiguration,
  CreateAgentTeamRequest,
  UpdateAgentTeamMemoryRequest,
} from '@worklite/contracts';
import { AgentTeamDocumentsService } from './executor-documents.service';
import { AgentTeamGroupsService } from './executor-groups.service';
import { ExecutorsService } from './executors.service';

@Controller('executors')
export class ExecutorsController {
  constructor(
    private readonly teams: ExecutorsService,
    private readonly groups: AgentTeamGroupsService,
  ) {}

  @Get()
  list(@Req() request: Request) {
    return this.teams.list(request, 'personal');
  }

  @Post()
  create(@Req() request: Request, @Body() body: CreateAgentTeamRequest) {
    return this.teams.create(request, 'personal', body);
  }

  @Get(':executorId')
  get(@Req() request: Request, @Param('executorId') executorId: string) {
    return this.teams.get(request, 'personal', executorId);
  }

  @Patch(':executorId')
  update(@Req() request: Request, @Param('executorId') executorId: string, @Body() body: UpdateAgentTeamRequest) {
    return this.teams.update(request, 'personal', executorId, body);
  }

  @Post(':executorId/roles')
  createRole(@Req() request: Request, @Param('executorId') executorId: string, @Body() body: Omit<AgentTeamRoleConfiguration, 'role'>) {
    return this.teams.createRole(request, 'personal', executorId, body);
  }

  @Patch(':executorId/roles/:roleId')
  updateRole(@Req() request: Request, @Param('executorId') executorId: string, @Param('roleId') roleId: string, @Body() body: Partial<Omit<AgentTeamRoleConfiguration, 'role'>>) {
    return this.teams.updateRole(request, 'personal', executorId, roleId, body);
  }

  @Delete(':executorId/roles/:roleId')
  deleteRole(@Req() request: Request, @Param('executorId') executorId: string, @Param('roleId') roleId: string) {
    return this.teams.deleteRole(request, 'personal', executorId, roleId);
  }

  @Get(':executorId/runs')
  records(@Req() request: Request, @Param('executorId') executorId: string) {
    return this.teams.records(request, 'personal', executorId);
  }

  @Get(':executorId/memories')
  memories(@Req() request: Request, @Param('executorId') executorId: string) {
    return this.groups.memories(request, 'personal', executorId);
  }

  @Post(':executorId/memories')
  createMemory(@Req() request: Request, @Param('executorId') executorId: string, @Body() body: CreateAgentTeamMemoryRequest) {
    return this.groups.createMemory(request, 'personal', executorId, body);
  }

  @Patch(':executorId/memories/:memoryId')
  updateMemory(@Req() request: Request, @Param('executorId') executorId: string, @Param('memoryId') memoryId: string, @Body() body: UpdateAgentTeamMemoryRequest) {
    return this.groups.updateMemory(request, 'personal', executorId, memoryId, body);
  }

  @Delete(':executorId/memories/:memoryId')
  deleteMemory(@Req() request: Request, @Param('executorId') executorId: string, @Param('memoryId') memoryId: string) {
    return this.groups.deleteMemory(request, 'personal', executorId, memoryId);
  }

  @Delete(':executorId')
  delete(@Req() request: Request, @Param('executorId') executorId: string, @Body() body: { confirmTeamId: string }) {
    return this.teams.delete(request, 'personal', executorId, body.confirmTeamId);
  }
}

@Controller('executor-groups')
export class ExecutorGroupsController {
  constructor(private readonly groups: AgentTeamGroupsService) {}

  @Get(':groupId')
  get(@Req() request: Request, @Param('groupId') groupId: string) {
    return this.groups.get(request, 'personal', groupId);
  }

  @Post(':groupId/controls')
  control(@Req() request: Request, @Param('groupId') groupId: string, @Body() body: AgentTeamGroupControlRequest) {
    return this.groups.control(request, 'personal', groupId, body);
  }

  @Get(':groupId/events')
  @Header('Cache-Control', 'no-cache, no-transform')
  async events(
    @Req() request: Request,
    @Param('groupId') groupId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    let lastSequence = parseLastEventId(lastEventId);
    await this.groups.get(request, 'personal', groupId);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let closed = false;
    let pending = false;
    const send = async () => {
      if (closed || pending) return;
      pending = true;
      try {
        const events: AgentTeamGroupEvent[] = await this.groups.events(request, 'personal', groupId, lastSequence);
        for (const event of events) {
          if (event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } finally {
        pending = false;
      }
    };
    const poll = setInterval(() => { void send(); }, 1000);
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
    };
    request.once('close', cleanup);
    await send();
  }
}

@Controller('executor-runs')
export class ExecutorRunsController {
  constructor(private readonly teams: ExecutorsService) {}

  @Get()
  list(
    @Req() request: Request,
  ) {
    const executorIds = request.query.executorId as string | string[] | undefined;
    const cursor = request.query.cursor as string | undefined;
    const limit = request.query.limit ? Number(request.query.limit) : undefined;

    const executorIdArray = executorIds ? (Array.isArray(executorIds) ? executorIds : [executorIds]) : [];

    return this.teams.listRuns(request, 'personal', executorIdArray, cursor, limit);
  }

  // Read-only node trees for several Runs at once (comma-separated runIds, at most 50).
  // Declared before :runId so "nodes" is not read as a Run id.
  @Get('nodes')
  nodes(@Req() request: Request) {
    const raw = request.query.runIds;
    const runIds = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => typeof value === 'string' ? value.split(',') : []);
    const executorIds = request.query.executorId;
    const executorIdArray = (Array.isArray(executorIds) ? executorIds : [executorIds]).filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    return this.teams.runNodes(request, 'personal', runIds, executorIdArray);
  }

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

@Controller('executor-documents')
export class ExecutorDocumentsController {
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
