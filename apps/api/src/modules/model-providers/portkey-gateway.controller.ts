import { Controller, Get, Post } from '@nestjs/common';
import { PortkeyGatewayService } from './portkey-gateway.service';

@Controller('portkey-gateway')
export class PortkeyGatewayController {
  constructor(private readonly gateway: PortkeyGatewayService) {}

  @Get()
  get() {
    return this.gateway.status();
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
