import { Global, Module } from '@nestjs/common';
import { UpgradesService, UpgradesController } from './upgrades.service';

@Global()
@Module({ providers: [UpgradesService], controllers: [UpgradesController], exports: [UpgradesService] })
export class UpgradesModule {}
