import { Module } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';

@Module({ providers: [DiagnosticsService], exports: [DiagnosticsService] })
export class DiagnosticsModule {}
