import { Body, Controller, Get, Header, Headers, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CommandExecutionEvent, CreateCommandRequest } from '@worklite/contracts';
import { CommandsService } from './commands.service';

@Controller('commands')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Post()
  create(@Body() body: CreateCommandRequest) {
    return this.commands.create(body);
  }

  @Get()
  list() {
    return this.commands.list();
  }

  @Get(':commandId/events')
  @Header('Cache-Control', 'no-cache, no-transform')
  async events(
    @Param('commandId') commandId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.commands.get(commandId);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    let lastSequence = parseLastEventId(lastEventId);
    let replaying = true;
    const pending: CommandExecutionEvent[] = [];
    let closed = false;

    const send = (event: CommandExecutionEvent) => {
      if (closed || event.commandId !== commandId || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = this.commands.subscribe((event) => {
      if (event.commandId !== commandId) return;
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

    for (const event of await this.commands.events(commandId, lastSequence)) send(event);
    replaying = false;
    pending.sort((left, right) => left.sequence - right.sequence).forEach(send);

    const execution = await this.commands.get(commandId);
    if (execution.status === 'succeeded' || execution.status === 'failed' || execution.status === 'cancelled') {
      cleanup();
      response.end();
    }
  }

  @Get(':commandId')
  get(@Param('commandId') commandId: string) {
    return this.commands.get(commandId);
  }

  @Post(':commandId/cancel')
  cancel(@Param('commandId') commandId: string) {
    return this.commands.cancel(commandId);
  }
}

function parseLastEventId(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
