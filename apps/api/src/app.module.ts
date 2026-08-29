import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health.controller';
import { DatabaseModule } from './infrastructure/database.module';
import { ObjectStorageModule } from './infrastructure/object-storage.module';
import { WorkspaceModule } from './modules/teams/teams.module';
import { AgentsModule } from './modules/agents/agents.module';
import { SkillsModule } from './modules/skills/skills.module';
import { McpServersModule } from './modules/mcp-servers/mcp-servers.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { WorkflowRevisionsModule } from './modules/workflow-revisions/workflow-revisions.module';
import { RunsModule } from './modules/runs/runs.module';
import { ArtifactsModule } from './modules/artifacts/artifacts.module';
import { ModelProvidersModule } from './modules/model-providers/model-providers.module';
import { UsageModule } from './modules/usage/usage.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { CommandsModule } from './modules/commands/commands.module';
import { PluginsModule } from './modules/plugins/plugins.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    CommandsModule,
    PluginsModule,
    ObjectStorageModule,
    WorkspaceModule,
    AgentsModule,
    SkillsModule,
    McpServersModule,
    WorkflowsModule,
    WorkflowRevisionsModule,
    RunsModule,
    ArtifactsModule,
    ModelProvidersModule,
    UsageModule,
    AuditLogsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
