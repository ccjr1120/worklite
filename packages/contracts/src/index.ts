export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type NodeErrorPolicy = 'stop' | 'retry';

export type HealthResponse = {
  status: 'ok';
};

export type CreateRunRequest = {
  input: unknown;
};

export type CreateRunResponse = {
  runId: string;
};

export type WorkflowRunView = {
  id: string;
  teamId: string;
  workflowVersionId: string;
  status: RunStatus;
  currentNodeId: string | null;
  input: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RunProgressEvent = {
  runId: string;
  type: 'run.status' | 'node.started' | 'node.completed' | 'node.failed';
  payload: unknown;
  occurredAt: string;
};
