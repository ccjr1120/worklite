import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, type WorkflowRunJob } from '@worklite/queue';

@Processor(QUEUE_NAMES.WORKFLOW_RUN)
export class WorkflowRunProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkflowRunProcessor.name);

  async process(job: Job<WorkflowRunJob>): Promise<void> {
    this.logger.log(`Received workflow run job ${job.data.runId}`);
  }
}
