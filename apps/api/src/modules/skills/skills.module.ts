import { Module } from '@nestjs/common';
import { CommandsModule } from '../commands/commands.module';
import { SkillScriptRunnerService } from './skill-script-runner.service';

@Module({ imports: [CommandsModule], providers: [SkillScriptRunnerService], exports: [SkillScriptRunnerService] })
export class SkillsModule {}
