import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { SkillsModule } from '../skills/skills.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentExecutionsService } from './agent-executions.service';

@Module({ imports: [WorkspaceModule, SkillsModule], controllers: [AgentsController], providers: [AgentsService, AgentExecutionsService] })
export class AgentsModule {}
