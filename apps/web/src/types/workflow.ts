type WorkflowStepStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled' | 'idle';

export type WorkflowStep = {
  id: string;
  position: number;
  agentId: string;
  agentName: string;
  agentVersion: string;
  nodeType?: 'text' | 'agent';
  agentVersionId?: string;
  text?: string;
  outputType?: 'text' | 'file';
  fileName?: string;
  fileType?: 'json' | 'text' | 'markdown';
  promptTemplate?: string;
  inputSummary: string;
  errorPolicy: 'stop' | 'retry';
  status?: WorkflowStepStatus;
};
