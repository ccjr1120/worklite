import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@worklite/contracts';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
