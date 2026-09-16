import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module';
import { WorkspaceModule } from '../teams/teams.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowSchedulesService } from './workflow-schedules.service';
import { WorkflowsService } from './workflows.service';
import { WorkflowVersionsController } from './workflow-versions.controller';

@Module({ imports: [WorkspaceModule, RunsModule], controllers: [WorkflowsController, WorkflowVersionsController], providers: [WorkflowsService, WorkflowSchedulesService], exports: [WorkflowsService] })
export class WorkflowsModule {}
