import { BadRequestException, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WorkspaceService } from '../teams/teams.service';
import { WechatOfficialAccountService } from '../connections/wechat-official-account.service';
import { AgentActionsService } from './agent-actions.service';

@Controller('agent-actions')
export class AgentActionsController {
  constructor(private readonly actions: AgentActionsService, private readonly workspaces: WorkspaceService, private readonly wechat: WechatOfficialAccountService) {}
  private async require(request: Request, id: string) {
    const workspace = await this.workspaces.getWorkspace(request, 'personal');
    return this.actions.require(workspace.id, id);
  }
  @Get('scan/:token')
  async scan(@Param('token') token: string, @Res() response: Response) { this.pageHeaders(response); response.type('html').send(await this.actions.page(token)); }
  @Post('scan/:token')
  async refreshScan(@Req() request: Request, @Param('token') token: string, @Res() response: Response) {
    if (!this.actions.allowPageOrigin(request.headers.origin, request.headers.host)) throw new BadRequestException('Invalid authorization page origin.');
    await this.actions.page(token, true);
    this.pageHeaders(response);
    response.redirect(303, request.originalUrl);
  }
  private pageHeaders(response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  }
  @Get(':actionId')
  async get(@Req() request: Request, @Param('actionId') id: string) { const action = await this.require(request, id); return this.actions.share(action.workspaceId, id); }
  @Post(':actionId/refresh')
  async refresh(@Req() request: Request, @Param('actionId') id: string) {
    const action = await this.require(request, id);
    return this.actions.refresh(action.workspaceId, id);
  }
  @Post(':actionId/open-login-browser')
  async openLogin(@Req() request: Request, @Param('actionId') id: string) { await this.require(request, id); return { expiresAt: await this.wechat.openLoginInBrowser(id) }; }
}
