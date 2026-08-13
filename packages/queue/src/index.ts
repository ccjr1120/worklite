export const QUEUE_NAMES = {
  WORKFLOW_RUN: 'workflow-run',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type WorkflowRunJob = {
  runId: string;
  teamId: string;
  workflowVersionId: string;
};
