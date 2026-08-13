import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '@worklite/queue';
import { DatabaseModule } from './infrastructure/database.module';
import { RedisModule } from './infrastructure/redis.module';
import { WorkflowRunProcessor } from './processors/workflow-run.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({ name: QUEUE_NAMES.WORKFLOW_RUN }),
  ],
  providers: [WorkflowRunProcessor],
})
export class AppModule {}
