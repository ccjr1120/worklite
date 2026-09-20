import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PortkeyGatewayService } from './portkey-gateway.service';
import type { CodexAccountUsageSnapshot, CodexRateLimitSnapshot, CreateModelProviderRequest, GatewayRequestLogDetail, GatewayRequestLogList, PortkeyGatewayStats, TestModelProviderRequest, UpdateModelProviderRequest } from '@worklite/contracts';

@Controller('portkey-gateway')
export class PortkeyGatewayController {
  constructor(private readonly gateway: PortkeyGatewayService) {}

  @Get()
  get() {
    return this.gateway.status();
  }

  @Get('providers')
  providers() {
    return this.gateway.providers();
  }

  @Get('stats')
  stats(@Query('window') window?: string): Promise<PortkeyGatewayStats> {
    return this.gateway.stats(window);
  }

  @Get('request-logs')
  requestLogs(
    @Query('provider') provider?: string,
    @Query('model') model?: string,
    @Query('statusClass') statusClass?: string,
    @Query('workflowRunId') workflowRunId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<GatewayRequestLogList> {
    return this.gateway.requestLogs({
      provider,
      model,
      statusClass: statusClass === 'success' || statusClass === 'client_error' || statusClass === 'server_error' ? statusClass : undefined,
      workflowRunId,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  @Get('request-logs/:requestLogId')
  requestLog(@Param('requestLogId') requestLogId: string): Promise<GatewayRequestLogDetail> {
    return this.gateway.requestLog(requestLogId);
  }

  @Get('codex/auth/status')
  codexAuthStatus() {
    return this.gateway.codexAuthStatus();
  }

  @Get('codex/rate-limits')
  codexRateLimits(): Promise<CodexRateLimitSnapshot> {
    return this.gateway.codexRateLimits();
  }

  @Get('codex/accounts/usage')
  codexAccountUsages(): Promise<CodexAccountUsageSnapshot> {
    return this.gateway.codexAccountUsages();
  }

  @Post('codex/auth/login')
  codexAuthLogin() {
    return this.gateway.startCodexLogin();
  }

  @Post('codex/accounts/import')
  codexAccountsImport(@Body() body: unknown) {
    return this.gateway.importCodexAccounts(body);
  }

  @Patch('codex/accounts/:accountId')
  codexAccountUpdate(@Param('accountId') accountId: string, @Body() body: { enabled: boolean }) {
    return this.gateway.updateCodexAccount(accountId, body.enabled);
  }

  @Post('codex/accounts/:accountId/refresh')
  codexAccountRefresh(@Param('accountId') accountId: string) {
    return this.gateway.refreshCodexAccount(accountId);
  }

  @Delete('codex/accounts/:accountId')
  codexAccountDelete(@Param('accountId') accountId: string) {
    return this.gateway.deleteCodexAccount(accountId);
  }

  @Post('providers')
  createProvider(@Body() body: CreateModelProviderRequest) {
    return this.gateway.createProvider(body);
  }

  @Patch('providers/:providerId')
  updateProvider(@Param('providerId') providerId: string, @Body() body: UpdateModelProviderRequest) {
    return this.gateway.updateProvider(providerId, body);
  }

  @Delete('providers/:providerId')
  deleteProvider(@Param('providerId') providerId: string) {
    return this.gateway.deleteProvider(providerId);
  }

  @Post('providers/:providerId/test')
  testProvider(@Param('providerId') providerId: string, @Body() body: TestModelProviderRequest) {
    return this.gateway.testProvider(providerId, body);
  }
}
