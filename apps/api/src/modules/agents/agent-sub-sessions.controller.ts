import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateAgentSubSessionRequest, UpdateAgentSubSessionRequest } from '@worklite/contracts';
import { AgentSubSessionsService } from './agent-sub-sessions.service';

@Controller('agent-sub-sessions')
export class AgentSubSessionsController {
  constructor(private readonly sessions: AgentSubSessionsService) {}

  @Get()
  list(@Req() request: Request) {
    return this.sessions.list(request, 'personal');
  }

  @Post()
  create(@Req() request: Request, @Body() body: CreateAgentSubSessionRequest) {
    return this.sessions.create(request, 'personal', body);
  }

  @Patch(':sessionId')
  update(@Req() request: Request, @Param('sessionId') sessionId: string, @Body() body: UpdateAgentSubSessionRequest) {
    return this.sessions.update(request, 'personal', sessionId, body);
  }

  @Delete(':sessionId')
  @HttpCode(204)
  delete(@Req() request: Request, @Param('sessionId') sessionId: string) {
    return this.sessions.delete(request, 'personal', sessionId);
  }
}
