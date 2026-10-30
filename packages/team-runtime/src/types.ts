export type AgentTeamMode = 'plan_only' | 'validate_existing' | 'implement_and_validate';

export type AgentTeamRole =
  | 'planner'
  | 'test_designer'
  | 'developer'
  | 'test_author'
  | 'test_runner'
  | 'reviewer'
  | 'worktree-manager';

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

export type AgentTeamDevelopmentAssignmentInput = {
  developerId?: string;
  title: string;
  scopeSummary: string;
  ownedPaths: string[];
  repositoryIds?: string[];
};

export type AgentTeamDevelopmentAssignment = {
  developerId: string;
  title: string;
  scopeSummary: string;
  ownedPaths: string[];
  repositoryIds?: string[];
};

export type AgentTeamGroupRunContext = {
  groupId: string;
  initialMessageId: string;
  initialMessage: string;
  targetRole: AgentTeamRoleId;
  mode: AgentTeamMode;
  repositories: Array<{ id: string; memoryRepositoryId: string; name: string; directory: string; projectInstructions: AgentTeamProjectInstructionFile[] }>;
  knownRepositories?: Array<{ name: string; directory: string }>;
  memories: Array<{ id: string; repositoryId: string | null; role: AgentTeamRoleId | null; content: string }>;
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

export type AgentTeamTargetedRepairRequest = {
  developerId: string;
  instruction: string;
};

export type AgentTeamDocument = {
  key: string;
  title: string;
  content: string;
  producingTaskKey: string;
  upstreamDocumentKeys: string[];
};

export type AgentTeamProjectGitDecision = {
  projectPath: string;
  strategy: 'no_git' | 'current_branch' | 'feature_branch' | 'worktree';
  branch?: string;
  worktreePath?: string;
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

export type AgentTeamTaskRequest = {
  runId: string;
  taskDefinition: AgentTeamTaskDefinition;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  upstream: readonly AgentTeamDocument[];
  pendingInputId?: string;
  answer?: string;
  repairInstruction?: string;
  developerId?: string;
  assignment?: AgentTeamDevelopmentAssignment;
  developmentAssignments?: readonly AgentTeamDevelopmentAssignment[];
  siblingResults?: Readonly<Record<string, Extract<AgentTeamTaskResult, { status: 'completed' }>>>;
  groupContext?: AgentTeamGroupRunContext;
  groupMessage?: string;
  handoffSummary?: string;
  fileReferences?: Array<{ documentId: string; revision: number; title: string }>;
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
      projectGitDecisions?: AgentTeamProjectGitDecision[];
      developmentAssignments?: AgentTeamDevelopmentAssignmentInput[];
      repositoryDirectories?: string[];
      repairRequest?: AgentTeamRepairRequest;
      repairRequests?: AgentTeamTargetedRepairRequest[];
      message?: string;
      handoff?: { role: AgentTeamRoleId; goal: string; repositoryIds?: string[] };
      dispatchDecision?: {
        mode: AgentTeamMode;
        rationale: string;
      };
    }
  | {
      status: 'waiting_for_input';
      pendingInput: AgentTeamPendingInput;
    };

export type AgentCoderGraphDelegate = {
  executeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult>;
};

export type AgentCoderGraphOptions = {
  maxRepairRounds?: number;
  orchestrationVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  developerIds?: readonly string[];
  developerConcurrency?: number;
};

export type AgentTeamRunRequest = {
  runId: string;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
};

export type AgentCoderGraphResult = AgentTeamRunRequest & {
  documents: readonly AgentTeamDocument[];
  unresolvedIssues: readonly string[];
  commandIds: readonly string[];
  criterionAssessments: readonly AgentTeamCriterionAssessment[];
  developmentAssignments: readonly AgentTeamDevelopmentAssignment[];
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
