import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowVersionsController } from './workflow-versions.controller';

@Module({ imports: [WorkspaceModule], controllers: [WorkflowsController, WorkflowVersionsController], providers: [WorkflowsService], exports: [WorkflowsService] })
export class WorkflowsModule {}
