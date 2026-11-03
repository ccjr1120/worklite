export type AgentTeamRoleId = string;

export type AgentTeamPendingInput = {
  id: string;
  question: string;
  scopeRevision: number;
};

export type AgentTeamPendingInputAnswer = {
  answer: string;
  directories?: readonly string[];
};

export type AgentTeamPendingInputAnswerMap = Record<string, AgentTeamPendingInputAnswer>;

export type AgentTeamGroupRunContext = {
  groupId: string;
  initialMessageId: string;
  initialMessage: string;
  targetRole: AgentTeamRoleId;
  requestedRole?: AgentTeamRoleId;
  continuation?: {
    sourceRunId: string;
    sourceTaskAttemptId: string;
    taskKey: string;
    role: AgentTeamRoleId;
    goal: string;
    savedProgress: string;
    fileReferences: Array<{ documentId: string; revision: number; title: string }>;
  };
  repositories: Array<{ id: string; memoryRepositoryId: string; name: string; directory: string; projectInstructions: AgentTeamProjectInstructionFile[] }>;
  knownRepositories?: Array<{ name: string; directory: string }>;
  memories: Array<{ id: string; repositoryId: string | null; content: string }>;
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
  role: AgentTeamRoleId;
  goal: string;
  dependencyKeys: readonly string[];
  inputDocumentVersions: readonly AgentTeamInputDocumentVersion[];
  expectedResultKind: string;
  acceptanceCriterionReferences: readonly string[];
};

export type AgentTeamRouterAssignment = {
  id: string;
  role: AgentTeamRoleId;
  goal: string;
  dependencyIds: readonly string[];
  repositoryIds?: readonly string[];
};

export type AgentTeamRouterPlan =
  | { action: 'dispatch'; assignments: readonly AgentTeamRouterAssignment[] }
  | { action: 'finish' };

export class AgentTeamTaskStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTeamTaskStoppedError';
  }
}

export type AgentTeamTaskRequest = {
  runId: string;
  taskDefinition: AgentTeamTaskDefinition;
  intent: string;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  upstream: readonly AgentTeamDocument[];
  pendingInputId?: string;
  answer?: string;
  groupContext?: AgentTeamGroupRunContext;
  groupMessage?: string;
  taskContextSummary?: string;
  fileReferences?: Array<{ documentId: string; revision: number; title: string }>;
};

export type AgentTeamTaskResult =
  | {
      status: 'completed';
      documents: AgentTeamDocument[];
      unresolvedIssues: string[];
      commandIds: string[];
      changedFiles: string[];
      completedWork: boolean;
      criterionAssessments: AgentTeamCriterionAssessment[];
      repositoryDirectories?: string[];
      message?: string;
      routerPlan?: AgentTeamRouterPlan;
    }
  | {
      status: 'waiting_for_input';
      pendingInput: AgentTeamPendingInput;
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
