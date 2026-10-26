import { forwardRef, Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { AgentsModule } from '../agents/agents.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { PluginsModule } from '../plugins/plugins.module';
import { ModelProvidersModule } from '../model-providers/model-providers.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';

@Module({ imports: [WorkspaceModule, ArtifactsModule, forwardRef(() => AgentsModule), forwardRef(() => PluginsModule), ModelProvidersModule], controllers: [RunsController], providers: [RunsService], exports: [RunsService] })
export class RunsModule {}
