import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { DiscoverModelProviderRequest } from '@worklite/contracts';
import { PortkeyGatewayService } from './portkey-gateway.service';

@Controller('portkey-gateway')
export class ProviderProxyController {
  constructor(private readonly proxyService: PortkeyGatewayService) {}

  @Post('model-providers/discover-models')
  discoverModels(@Body() body: DiscoverModelProviderRequest) {
    return this.proxyService.discoverModels(body);
  }

  @Get('v1/models')
  unifiedModels(@Req() request: Request) {
    return this.proxyService.models(request);
  }

  @Post('v1/chat/completions')
  unifiedChatCompletions(@Req() request: Request, @Res() response: Response) {
    return this.proxyService.proxyUnified(request, response, 'chat/completions');
  }

  @Post('v1/responses')
  unifiedResponses(@Req() request: Request, @Res() response: Response) {
    return this.proxyService.proxyUnified(request, response, 'responses');
  }

  @Post('v1/messages')
  unifiedMessages(@Req() request: Request, @Res() response: Response) {
    return this.proxyService.proxyUnified(request, response, 'messages');
  }

  @Post('v1/images/generations')
  unifiedImageGenerations(@Req() request: Request, @Res() response: Response) {
    return this.proxyService.proxyUnified(request, response, 'images/generations');
  }
}
