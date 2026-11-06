import { Controller, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { agentPendingActions, type Database } from '@worklite/db';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from '../teams/teams.service';
import { WechatOfficialAccountService } from '../connections/wechat-official-account.service';

@Controller('agent-actions')
export class AgentActionsController {
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly workspaces: WorkspaceService, private readonly wechat: WechatOfficialAccountService) {}
  private async require(request: Request, id: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    const action = this.db.select().from(agentPendingActions).where(and(eq(agentPendingActions.id, id), eq(agentPendingActions.workspaceId, workspace.id))).get();
    if (!action) throw new NotFoundException('Agent action not found.');
    return action;
  }
  @Get(':actionId')
  async get(@Req() request: Request, @Param('actionId') id: string) { const action = await this.require(request, id); return { ...action, qrCode: null }; }
  @Post(':actionId/refresh')
  async refresh(@Req() request: Request, @Param('actionId') id: string) {
    await this.require(request, id);
    const pending = await this.wechat.refresh(id);
    this.db.update(agentPendingActions).set({ qrCode: pending.qrCode, expiresAt: pending.expiresAt, status: 'pending', updatedAt: new Date() }).where(eq(agentPendingActions.id, id)).run();
    return pending;
  }
  @Post(':actionId/open-login-browser')
  async openLogin(@Req() request: Request, @Param('actionId') id: string) { await this.require(request, id); return { expiresAt: await this.wechat.openLoginInBrowser(id) }; }
}
