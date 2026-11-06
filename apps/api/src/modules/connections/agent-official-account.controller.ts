import { Controller, Get, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService } from '../agents/agents.service';
import { WechatOfficialAccountService } from './wechat-official-account.service';

@Controller('agents/:agentId/wechat-official-account')
export class AgentOfficialAccountController {
  constructor(private readonly agents: AgentsService, private readonly officialAccount: WechatOfficialAccountService) {}

  @Get()
  async get(@Req() request: Request, @Param('agentId') agentId: string, @Query('parentId') parentId?: string) {
    await this.requirePublisher(request, agentId, parentId);
    return this.officialAccount.getAccount();
  }

  @Post('login')
  async login(@Req() request: Request, @Param('agentId') agentId: string, @Query('parentId') parentId?: string) {
    await this.requirePublisher(request, agentId, parentId);
    return this.officialAccount.startAccountLogin();
  }

  @Post('disconnect')
  async disconnect(@Req() request: Request, @Param('agentId') agentId: string, @Query('parentId') parentId?: string) {
    await this.requirePublisher(request, agentId, parentId);
    return this.officialAccount.disconnect();
  }

  private async requirePublisher(request: Request, agentId: string, parentId?: string) {
    const agent = await this.agents.get(request, 'personal', agentId, parentId);
    if (!agent.collaboration?.capabilities.some((capability) => capability.type === 'wechat-official-account/publish')) {
      throw new NotFoundException('This Agent has no WeChat Official Account publishing capability.');
    }
  }
}
