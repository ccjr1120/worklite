import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import type { UpdatePortkeyGatewayRequest } from '@worklite/contracts';
import { PortkeyGatewayService } from './portkey-gateway.service';

@Controller('portkey-gateway')
export class PortkeyGatewayController {
  constructor(private readonly gateway: PortkeyGatewayService) {}

  @Get()
  get() {
    return this.gateway.status();
  }

  @Patch()
  update(@Body() body: UpdatePortkeyGatewayRequest) {
    return this.gateway.updateGateway(body);
  }

  @Post('start')
  start() {
    return this.gateway.start();
  }

  @Post('stop')
  stop() {
    return this.gateway.stop();
  }

  @Post('restart')
  restart() {
    return this.gateway.restart();
  }
}
