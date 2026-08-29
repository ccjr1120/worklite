import { Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService } from './agents.service';

@Controller('agent-versions')
export class AgentVersionsController {
  constructor(private readonly agents: AgentsService) {}

  @Get(':versionId')
  get(@Req() request: Request, @Param('versionId') versionId: string) {
    return this.agents.version(request, 'personal', versionId);
  }
}
