import { Module } from '@nestjs/common';
import { ProviderProxyController } from './provider-proxy.controller';
import { PortkeyGatewayController } from './portkey-gateway.controller';
import { PortkeyGatewayService } from './portkey-gateway.service';

@Module({ controllers: [ProviderProxyController, PortkeyGatewayController], providers: [PortkeyGatewayService], exports: [PortkeyGatewayService] })
export class ModelProvidersModule {}
