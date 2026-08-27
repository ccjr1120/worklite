import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

@Module({ imports: [WorkspaceModule], controllers: [WorkflowsController], providers: [WorkflowsService], exports: [WorkflowsService] })
export class WorkflowsModule {}
