import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module';
import { WorkspaceModule } from '../teams/teams.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({ imports: [WorkspaceModule, RunsModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
