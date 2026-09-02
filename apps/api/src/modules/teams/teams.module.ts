import { Module } from '@nestjs/common';
import { WorkspaceService } from './teams.service';
import { WorkspaceResourcesController } from './team-resources.controller';
import { WorkspaceResourcesService } from './team-resources.service';
import { SkillsModule } from '../skills/skills.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';

@Module({ imports: [SkillsModule, McpServersModule, DiagnosticsModule], controllers: [WorkspaceResourcesController], providers: [WorkspaceService, WorkspaceResourcesService], exports: [WorkspaceService, WorkspaceResourcesService] })
export class WorkspaceModule {}
