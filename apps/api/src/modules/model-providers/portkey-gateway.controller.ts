import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { PortkeyGatewayService } from './portkey-gateway.service';
import type { CreateModelProviderRequest, UpdateModelProviderRequest } from '@worklite/contracts';

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
  testProvider(@Param('providerId') providerId: string) {
    return this.gateway.testProvider(providerId);
  }
}
