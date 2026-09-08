import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PortkeyGatewayService } from './portkey-gateway.service';
import type { CodexRateLimitSnapshot, CreateModelProviderRequest, PortkeyGatewayStats, TestModelProviderRequest, UpdateModelProviderRequest } from '@worklite/contracts';

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

  @Get('codex/auth/status')
  codexAuthStatus() {
    return this.gateway.codexAuthStatus();
  }

  @Get('codex/rate-limits')
  codexRateLimits(): Promise<CodexRateLimitSnapshot> {
    return this.gateway.codexRateLimits();
  }

  @Post('codex/auth/login')
  codexAuthLogin() {
    return this.gateway.startCodexLogin();
  }

  @Post('codex/auth/refresh')
  codexAuthRefresh() {
    return this.gateway.refreshCodexCredential();
  }

  @Post('codex/auth/logout')
  codexAuthLogout() {
    return this.gateway.logoutCodex();
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
