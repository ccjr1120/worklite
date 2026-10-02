export type AgentTeamMode = 'plan_only' | 'validate_existing' | 'implement_and_validate';

export type AgentTeamRole =
  | 'planner'
  | 'test_designer'
  | 'developer'
  | 'test_author'
  | 'test_runner'
  | 'reviewer';

export type AgentTeamPendingInput = {
  id: string;
  question: string;
  scopeRevision: number;
};

export type AgentTeamDocument = {
  key: string;
  title: string;
  content: string;
  producingTaskKey: string;
  upstreamDocumentKeys: string[];
};

export type AgentTeamTaskRequest = {
  runId: string;
  taskKey: string;
  role: AgentTeamRole;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  scopeRevision: number;
  upstream: readonly AgentTeamDocument[];
  pendingInputId?: string;
  answer?: string;
};

export type AgentTeamTaskResult =
  | {
      status: 'completed';
      documents: AgentTeamDocument[];
      unresolvedIssues: string[];
    }
  | {
      status: 'waiting_for_input';
      pendingInput: AgentTeamPendingInput;
    };

export type AgentTeamGraphDelegate = {
  executeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult>;
};

export type AgentTeamRunRequest = {
  runId: string;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  scopeRevision: number;
};

export type AgentTeamGraphResult = AgentTeamRunRequest & {
  documents: readonly AgentTeamDocument[];
  unresolvedIssues: readonly string[];
};

export type AgentTeamOperationStatus = 'reserved' | 'completed' | 'uncertain' | 'failed';

export type AgentTeamOperationRecord = {
  key: string;
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
  status: AgentTeamOperationStatus;
  commandId?: string;
  result?: unknown;
  failureReason?: string;
};

export type AgentTeamOperationRequest = {
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
};

export type AgentTeamOperationJournal = {
  findOperation(operationKey: string): Promise<AgentTeamOperationRecord | undefined>;
  reserveOperation(request: AgentTeamOperationRequest): Promise<AgentTeamOperationRecord>;
  completeOperation(operationKey: string, result: unknown, commandId?: string): Promise<AgentTeamOperationRecord>;
  markOperationUncertain(operationKey: string, reason: string): Promise<AgentTeamOperationRecord>;
  failOperation(operationKey: string, reason: string): Promise<AgentTeamOperationRecord>;
};
