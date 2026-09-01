import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { ProviderProxyController } from './provider-proxy.controller';
import { PortkeyGatewayController } from './portkey-gateway.controller';
import { PortkeyGatewayService } from './portkey-gateway.service';

@Module({ imports: [WorkspaceModule], controllers: [ProviderProxyController, PortkeyGatewayController], providers: [PortkeyGatewayService] })
export class ModelProvidersModule {}
