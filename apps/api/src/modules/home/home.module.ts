import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../teams/teams.module';
import { HomeBoardAssignmentsController } from './home-board-assignments.controller';
import { HomeBoardCategoriesController } from './home-board-categories.controller';
import { HomeBoardCategoriesService } from './home-board-categories.service';

@Module({
  imports: [WorkspaceModule],
  controllers: [HomeBoardCategoriesController, HomeBoardAssignmentsController],
  providers: [HomeBoardCategoriesService],
})
export class HomeModule {}
