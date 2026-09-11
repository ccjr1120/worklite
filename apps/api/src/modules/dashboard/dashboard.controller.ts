import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { UpdateDashboardRequest, UpsertWorkflowScheduleRequest } from '@worklite/contracts';
import type { Request } from 'express';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get() get(@Req() request: Request) { return this.dashboard.get(request); }
  @Put() update(@Req() request: Request, @Body() body: UpdateDashboardRequest) { return this.dashboard.update(request, body); }
  @Put('schedule') schedule(@Req() request: Request, @Body() body: UpsertWorkflowScheduleRequest) { return this.dashboard.upsertSchedule(request, body); }
  @Post('run') run(@Req() request: Request) { return this.dashboard.runNow(request); }
}
