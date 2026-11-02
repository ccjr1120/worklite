import { Module } from '@nestjs/common';
import { ApiRequestLogsController } from './api-request-logs.controller';
import { ApiRequestLogsService } from './api-request-logs.service';

@Module({
  controllers: [ApiRequestLogsController],
  providers: [ApiRequestLogsService],
  exports: [ApiRequestLogsService],
})
export class ApiRequestLogsModule {}
