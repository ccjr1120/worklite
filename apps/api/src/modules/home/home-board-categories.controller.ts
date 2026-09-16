import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { CreateHomeBoardCategoryRequest, UpdateHomeBoardCategoryRequest } from '@worklite/contracts';
import { HomeBoardCategoriesService } from './home-board-categories.service';

@Controller('home/board-categories')
export class HomeBoardCategoriesController {
  constructor(private readonly categories: HomeBoardCategoriesService) {}

  @Get()
  list(@Req() request: Request) {
    return this.categories.list(request);
  }

  @Post()
  create(@Req() request: Request, @Body() body: CreateHomeBoardCategoryRequest) {
    return this.categories.create(request, body);
  }

  @Patch(':categoryId')
  update(@Req() request: Request, @Param('categoryId') categoryId: string, @Body() body: UpdateHomeBoardCategoryRequest) {
    return this.categories.update(request, categoryId, body);
  }

  @Delete(':categoryId')
  delete(@Req() request: Request, @Param('categoryId') categoryId: string) {
    return this.categories.delete(request, categoryId);
  }
}
