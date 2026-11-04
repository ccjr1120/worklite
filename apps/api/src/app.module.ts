import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './common/health.controller';
import { DatabaseModule } from './infrastructure/database.module';
import { WorkspaceModule } from './modules/teams/teams.module';
import { AgentsModule } from './modules/agents/agents.module';
import { SkillsModule } from './modules/skills/skills.module';
import { McpServersModule } from './modules/mcp-servers/mcp-servers.module';
import { WebSearchModule } from './modules/web-search/web-search.module';
import { ArtifactsModule } from './modules/artifacts/artifacts.module';
import { ModelProvidersModule } from './modules/model-providers/model-providers.module';
import { UsageModule } from './modules/usage/usage.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { CommandsModule } from './modules/commands/commands.module';
import { PluginsModule } from './modules/plugins/plugins.module';
import { UpgradesModule } from './modules/upgrades/upgrades.module';
import { LocalProjectsModule } from './modules/local-projects/local-projects.module';
import { ApiRequestLogsModule } from './modules/api-request-logs/api-request-logs.module';

@Module({
  imports: [
    // Managed releases receive configuration through their inherited process environment;
    // avoiding dotenv file discovery keeps API cutover startup independent of local files.
    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: process.env.WORKLITE_MANAGED_GATEWAY === '1' }),
    DatabaseModule,
    ApiRequestLogsModule,
    UpgradesModule,
    CommandsModule,
    PluginsModule,
    LocalProjectsModule,
    WorkspaceModule,
    AgentsModule,
    SkillsModule,
    McpServersModule,
    WebSearchModule,
    ArtifactsModule,
    ModelProvidersModule,
    UsageModule,
    AuditLogsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
