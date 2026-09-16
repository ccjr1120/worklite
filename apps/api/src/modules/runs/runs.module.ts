import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentsModule } from '../agents/agents.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { PluginsModule } from '../plugins/plugins.module';

@Module({ imports: [WorkspaceModule, AgentsModule, PluginsModule], controllers: [RunsController], providers: [RunsService], exports: [RunsService] })
export class RunsModule {}
