import { Module } from '@nestjs/common';
import { LocalProjectsController } from './local-projects.controller';
import { LocalProjectsService } from './local-projects.service';

@Module({
  controllers: [LocalProjectsController],
  providers: [LocalProjectsService],
  exports: [LocalProjectsService],
})
export class LocalProjectsModule {}
