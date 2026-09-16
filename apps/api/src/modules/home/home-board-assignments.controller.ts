import { Body, Controller, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AssignHomeBoardRequest } from '@worklite/contracts';
import { HomeBoardCategoriesService } from './home-board-categories.service';

@Controller('home/board-assignments')
export class HomeBoardAssignmentsController {
  constructor(private readonly categories: HomeBoardCategoriesService) {}

  @Put()
  assign(@Req() request: Request, @Body() body: AssignHomeBoardRequest) {
    return this.categories.assign(request, body);
  }
}
