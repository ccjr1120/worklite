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

export type AgentTeamPendingInputAnswer = {
  answer: string;
  authorizedCommands: readonly string[];
};

export type AgentTeamProjectInstructionFile = {
  path: string;
  content: string;
};

export type AgentTeamCriterionAssessment = {
  criterion: string;
  assessment: 'met' | 'unmet' | 'not_verified';
  evidence: string[];
};

export type AgentTeamRepairRequest = {
  taskKey: string;
  instruction: string;
};

export type AgentTeamDocument = {
  key: string;
  title: string;
  content: string;
  producingTaskKey: string;
  upstreamDocumentKeys: string[];
};

export type AgentTeamInputDocumentVersion = {
  key: string;
  contentFingerprint: string;
};

export type AgentTeamTaskDefinition = {
  taskKey: string;
  role: AgentTeamRole;
  goal: string;
  dependencyKeys: readonly string[];
  inputDocumentVersions: readonly AgentTeamInputDocumentVersion[];
  expectedResultKind: string;
  acceptanceCriterionReferences: readonly string[];
};

export type AgentTeamTaskRequest = {
  runId: string;
  taskDefinition: AgentTeamTaskDefinition;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  authorizedCommands: readonly string[];
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  upstream: readonly AgentTeamDocument[];
  pendingInputId?: string;
  answer?: string;
  repairInstruction?: string;
};

export type AgentTeamTaskResult =
  | {
      status: 'completed';
      documents: AgentTeamDocument[];
      unresolvedIssues: string[];
      commandIds: string[];
      changedFiles: string[];
      completedAssignedWork: boolean;
      criterionAssessments: AgentTeamCriterionAssessment[];
      repairRequest?: AgentTeamRepairRequest;
    }
  | {
      status: 'waiting_for_input';
      pendingInput: AgentTeamPendingInput;
    };

export type AgentTeamGraphDelegate = {
  executeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult>;
};

export type AgentTeamGraphOptions = {
  maxRepairRounds?: number;
};

export type AgentTeamRunRequest = {
  runId: string;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  authorizedCommands: readonly string[];
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
};

export type AgentTeamGraphResult = AgentTeamRunRequest & {
  documents: readonly AgentTeamDocument[];
  unresolvedIssues: readonly string[];
  commandIds: readonly string[];
  criterionAssessments: readonly AgentTeamCriterionAssessment[];
};

export type AgentTeamOperationStatus = 'reserved' | 'completed' | 'uncertain' | 'failed';

export type AgentTeamOperationRecoveryDecision =
  | { type: 'adopt_command' }
  | { type: 'mark_failed' }
  | { type: 'replay'; replayOperationKey: string };

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
  recoveryDecision?: AgentTeamOperationRecoveryDecision;
};

export type AgentTeamOperationRequest = {
  taskKey: string;
  operationKey: string;
  toolName: string;
  inputFingerprint: string;
};

export type AgentTeamOperationJournal = {
  findOperation(operationKey: string): Promise<AgentTeamOperationRecord | undefined>;
  reserveOperation(request: AgentTeamOperationRequest, commandId?: string): AgentTeamOperationRecord;
  completeOperation(operationKey: string, result: unknown, commandId?: string): Promise<AgentTeamOperationRecord>;
  markOperationUncertain(operationKey: string, reason: string): Promise<AgentTeamOperationRecord>;
  failOperation(operationKey: string, reason: string): Promise<AgentTeamOperationRecord>;
};
