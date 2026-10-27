import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { GATEWAY_STATS_GROUP_BYS, GATEWAY_SURFACES } from '@worklite/contracts';
import { PortkeyGatewayService } from './portkey-gateway.service';
import type { CodexAccountUsageSnapshot, CodexRateLimitSnapshot, CreateModelProviderRequest, GatewayAttributionFilters, GatewayRequestLogDetail, GatewayRequestLogList, GatewayStatsGroupBy, GatewaySurface, PortkeyGatewayStats, TestModelProviderRequest, UpdateModelProviderRequest } from '@worklite/contracts';

// Express turns a repeated query parameter into an array, so every value is reduced to
// one string before it is validated or forwarded; a repeated filter takes its first
// value rather than reaching the Gateway as a malformed one.
type RawQuery = Record<string, unknown>;

function queryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

// An unrecognised surface or groupBy is rejected rather than ignored: ignoring it
// answers an unfiltered question that looks filtered, which is the one failure mode
// this attribution is meant to rule out. The id filters are opaque and pass through.
function attributionFilters(query: RawQuery): GatewayAttributionFilters {
  const surface = queryText(query.surface);
  if (surface && !GATEWAY_SURFACES.includes(surface as GatewaySurface)) {
    throw new BadRequestException(`Unknown Gateway usage surface ${surface}.`);
  }
  return {
    surface: surface as GatewaySurface | undefined,
    conversationId: queryText(query.conversationId),
    projectTaskId: queryText(query.projectTaskId),
    executor: queryText(query.executor),
    teamId: queryText(query.teamId),
    teamRunId: queryText(query.teamRunId),
    workflowId: queryText(query.workflowId),
    workflowRunId: queryText(query.workflowRunId),
  };
}

function statsGroupBy(value: unknown): GatewayStatsGroupBy | undefined {
  const groupBy = queryText(value);
  if (!groupBy) return undefined;
  if (!GATEWAY_STATS_GROUP_BYS.includes(groupBy as GatewayStatsGroupBy)) {
    throw new BadRequestException(`Unknown Gateway usage grouping ${groupBy}.`);
  }
  return groupBy as GatewayStatsGroupBy;
}

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
  stats(@Query() query: RawQuery): Promise<PortkeyGatewayStats> {
    return this.gateway.stats({
      from: queryText(query.from),
      to: queryText(query.to),
      groupBy: statsGroupBy(query.groupBy),
      ...attributionFilters(query),
    });
  }

  @Get('request-logs')
  requestLogs(@Query() query: RawQuery): Promise<GatewayRequestLogList> {
    const statusClass = queryText(query.statusClass);
    const limit = queryText(query.limit);
    return this.gateway.requestLogs({
      from: queryText(query.from),
      to: queryText(query.to),
      provider: queryText(query.provider),
      model: queryText(query.model),
      statusClass: statusClass === 'success' || statusClass === 'client_error' || statusClass === 'server_error' ? statusClass : undefined,
      ...attributionFilters(query),
      limit: limit ? Number(limit) : undefined,
      cursor: queryText(query.cursor),
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
