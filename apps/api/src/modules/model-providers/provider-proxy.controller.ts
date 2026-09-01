import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { DiscoverModelProviderRequest } from '@worklite/contracts';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { PortkeyGatewayService } from './portkey-gateway.service';

@Controller('portkey-gateway')
export class ProviderProxyController {
  constructor(private readonly proxyService: PortkeyGatewayService, private readonly resources: WorkspaceResourcesService) {}

  @Post('model-providers/discover-models')
  discoverModels(@Body() body: DiscoverModelProviderRequest) {
    return this.proxyService.discoverModels(body);
  }

  @Get('providers/:providerId/v1/models')
  models(@Req() request: Request, @Res() response: Response, @Param('providerId') providerId: string) {
    return this.proxyService.proxy(request, response, providerId, 'models');
  }

  @Post('providers/:providerId/v1/chat/completions')
  chatCompletions(@Req() request: Request, @Res() response: Response, @Param('providerId') providerId: string) {
    return this.proxyService.proxy(request, response, providerId, 'chat/completions');
  }

  @Post('providers/:providerId/v1/responses')
  responses(@Req() request: Request, @Res() response: Response, @Param('providerId') providerId: string) {
    return this.proxyService.proxy(request, response, providerId, 'responses');
  }

  @Post('providers/:providerId/test')
  testProvider(@Req() request: Request, @Param('providerId') providerId: string) {
    return this.resources.testProvider(request, 'personal', providerId);
  }
}
