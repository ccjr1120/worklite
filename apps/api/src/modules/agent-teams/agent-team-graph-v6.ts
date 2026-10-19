import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  DEVELOPER_LANE_IDS,
  normalizeDynamicDevelopmentAssignments,
  requestTeamInput,
  type AgentTeamGroupRunContext,
  type AgentTeamMode,
  type AgentTeamPendingInput,
  type AgentTeamProjectInstructionFile,
  type AgentTeamRoleId,
  type AgentTeamTaskRequest,
  type AgentTeamTaskResult,
} from '@worklite/team-runtime';

const MAX_AUTOMATIC_HANDOFFS = 16;

export type AgentTeamGroupGraphInitial = {
  runId: string;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  authorizedCommands: readonly string[];
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  groupContext: AgentTeamGroupRunContext;
};

type GroupGraphState = {
  runId: string;
  intent: string;
  mode: AgentTeamMode;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  authorizedCommands: readonly string[];
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  groupContext: AgentTeamGroupRunContext;
  currentRole: AgentTeamRoleId;
  currentGoal: string;
  currentMessage: string;
  handoffSummary: string;
  fileReferences: Array<{ documentId: string; revision: number; title: string }>;
  selectedRepositoryIds: readonly string[];
  assignments: readonly { developerId: string; title: string; scopeSummary: string; ownedPaths: string[]; repositoryIds?: string[] }[];
  step: number;
  taskPendingInputIds: Record<string, string>;
  taskAnswers: Record<string, string>;
  pendingInput: AgentTeamPendingInput | null;
  activeTaskKey: string | null;
  finished: boolean;
  handoffLimitReached: boolean;
};

export type AgentTeamGroupGraphState = GroupGraphState;

export type AgentTeamGroupGraphDelegate = {
  executeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult>;
  documentReferences?(runId: string, taskKey: string): Promise<Array<{ documentId: string; revision: number; title: string }>>;
  bindGroupDirectories?(runId: string, directories: readonly string[], source: 'answer' | 'role'): Promise<AgentTeamGroupRunContext['repositories']>;
};

const groupState = Annotation.Root({
  runId: Annotation<string>(),
  intent: Annotation<string>(),
  mode: Annotation<AgentTeamMode>(),
  projectDirectory: Annotation<string>(),
  outputDirectory: Annotation<string>(),
  scopeRevision: Annotation<number>(),
  authorizedCommands: Annotation<readonly string[]>({ reducer: (_left, right) => right, default: () => [] }),
  projectInstructions: Annotation<readonly AgentTeamProjectInstructionFile[]>({ reducer: (_left, right) => right, default: () => [] }),
  groupContext: Annotation<AgentTeamGroupRunContext>(),
  currentRole: Annotation<AgentTeamRoleId>(),
  currentGoal: Annotation<string>(),
  currentMessage: Annotation<string>(),
  handoffSummary: Annotation<string>(),
  fileReferences: Annotation<Array<{ documentId: string; revision: number; title: string }>>({ reducer: (_left, right) => right, default: () => [] }),
  selectedRepositoryIds: Annotation<readonly string[]>({ reducer: (_left, right) => right, default: () => [] }),
  assignments: Annotation<GroupGraphState['assignments']>({ reducer: (_left, right) => right, default: () => [] }),
  step: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  taskPendingInputIds: Annotation<Record<string, string>>({ reducer: (left, right) => ({ ...left, ...right }), default: () => ({}) }),
  taskAnswers: Annotation<Record<string, string>>({ reducer: (left, right) => ({ ...left, ...right }), default: () => ({}) }),
  pendingInput: Annotation<AgentTeamPendingInput | null>({ reducer: (_left, right) => right, default: () => null }),
  activeTaskKey: Annotation<string | null>({ reducer: (_left, right) => right, default: () => null }),
  finished: Annotation<boolean>({ reducer: (_left, right) => right, default: () => false }),
  handoffLimitReached: Annotation<boolean>({ reducer: (_left, right) => right, default: () => false }),
});

export function createAgentTeamGroupGraph(
  delegate: AgentTeamGroupGraphDelegate,
  checkpointer: BaseCheckpointSaver | undefined,
  initial: AgentTeamGroupGraphInitial,
) {
  const runRole = async (state: GroupGraphState): Promise<Partial<GroupGraphState>> => {
    const nextStep = state.step + 1;
    const common = {
      runId: state.runId,
      intent: state.currentGoal,
      mode: state.mode,
      projectDirectory: state.projectDirectory,
      outputDirectory: state.outputDirectory,
      scopeRevision: state.scopeRevision,
      authorizedCommands: state.authorizedCommands,
      projectInstructions: state.projectInstructions,
      groupContext: state.groupContext,
      groupMessage: state.currentMessage,
      handoffSummary: state.handoffSummary,
      fileReferences: state.fileReferences,
      upstream: [],
      taskDefinition: {
        taskKey: `group_${state.step}_${state.currentRole}`,
        role: state.currentRole,
        goal: state.currentGoal,
        dependencyKeys: [],
        inputDocumentVersions: [],
        expectedResultKind: 'message, question, file references, assignments, and optional next-role handoff',
        acceptanceCriterionReferences: [],
      },
      pendingInputId: state.taskPendingInputIds[`group_${state.step}_${state.currentRole}`],
      answer: state.taskAnswers[`group_${state.step}_${state.currentRole}`],
    } satisfies Omit<AgentTeamTaskRequest, 'projectDirectory'> & { projectDirectory: string };
    const execution = state.currentRole === 'developer' && state.assignments.length > 0
      ? await runDeveloperAssignments(delegate, state, common)
      : {
        result: await delegate.executeTask(await withRepositoryScope(common, state.selectedRepositoryIds, state.groupContext)),
        pendingTaskKey: undefined,
        pendingInputIds: {},
        fileReferences: await delegate.documentReferences?.(state.runId, common.taskDefinition.taskKey) ?? [],
      };
    const result = execution.result;

    if (result.status === 'waiting_for_input') {
      const activeTaskKey = execution.pendingTaskKey ?? `group_${state.step}_${state.currentRole}`;
      return {
        pendingInput: result.pendingInput,
        activeTaskKey,
        taskPendingInputIds: { ...execution.pendingInputIds, [activeTaskKey]: result.pendingInput.id },
        finished: false,
      };
    }

    // A role that identified the project directories itself binds them before routing:
    // the registration extends the captured scope so later handoffs validate against it.
    let scopeContext = state.groupContext;
    let scopeSelectedIds = state.selectedRepositoryIds;
    let scopeProjectDirectory = state.projectDirectory;
    if (result.repositoryDirectories?.length && delegate.bindGroupDirectories) {
      const bound = (await delegate.bindGroupDirectories(state.runId, result.repositoryDirectories, 'role'))
        .filter((repository) => !state.groupContext.repositories.some((existing) => existing.id === repository.id));
      if (bound.length) {
        scopeContext = { ...state.groupContext, repositories: [...state.groupContext.repositories, ...bound] };
        scopeSelectedIds = [...new Set([...state.selectedRepositoryIds, ...bound.map((repository) => repository.id)])];
        scopeProjectDirectory = state.projectDirectory || bound[0]!.directory;
      }
    }
    const scopeUpdate = scopeContext === state.groupContext ? {} : {
      groupContext: scopeContext,
      selectedRepositoryIds: scopeSelectedIds,
      projectDirectory: scopeProjectDirectory,
    };

    const handoff = result.handoff;
    if (!handoff) return { step: nextStep, finished: true, pendingInput: null, activeTaskKey: null, assignments: [], ...scopeUpdate };
    if (nextStep >= MAX_AUTOMATIC_HANDOFFS) {
      return { step: nextStep, finished: true, handoffLimitReached: true, pendingInput: null, activeTaskKey: null, assignments: [], ...scopeUpdate };
    }
    const repositoryIds = handoff.repositoryIds?.length ? handoff.repositoryIds : [...scopeSelectedIds];
    const scopedIds = new Set(scopeContext.repositories.map((repository) => repository.id));
    if (repositoryIds.some((id) => !scopedIds.has(id))) throw new Error('A role handoff requested a repository outside this Run scope.');
    const assignments = handoff.role === 'developer' && result.developmentAssignments?.length
      ? normalizeDynamicDevelopmentAssignments(result.developmentAssignments, DEVELOPER_LANE_IDS)
        .map((assignment, index) => ({
          ...assignment,
          repositoryIds: result.developmentAssignments?.[index]?.repositoryIds?.length
            ? result.developmentAssignments[index]!.repositoryIds
            : repositoryIds,
        }))
      : [];
    if (assignments.some((assignment) => assignment.repositoryIds?.some((id) => !repositoryIds.includes(id)))) {
      throw new Error('A Developer assignment requested a repository outside its handoff scope.');
    }
    return {
      step: nextStep,
      currentRole: handoff.role,
      currentGoal: handoff.goal,
      currentMessage: handoff.goal,
      handoffSummary: result.message?.trim() ?? '',
      fileReferences: execution.fileReferences,
      selectedRepositoryIds: repositoryIds,
      assignments,
      pendingInput: null,
      activeTaskKey: null,
      taskPendingInputIds: {},
      taskAnswers: {},
      finished: false,
      // selectedRepositoryIds above already incorporates the newly bound scope.
      ...(scopeContext === state.groupContext ? {} : { groupContext: scopeContext, projectDirectory: scopeProjectDirectory }),
    };
  };

  const graph = new StateGraph(groupState)
    .addNode('start', async () => ({
      runId: initial.runId,
      intent: initial.intent,
      mode: initial.mode,
      projectDirectory: initial.projectDirectory,
      outputDirectory: initial.outputDirectory,
      scopeRevision: initial.scopeRevision,
      authorizedCommands: initial.authorizedCommands,
      projectInstructions: initial.projectInstructions,
      groupContext: initial.groupContext,
      currentRole: initial.groupContext.targetRole,
      currentGoal: initial.intent,
      currentMessage: initial.groupContext.initialMessage,
      handoffSummary: '',
      fileReferences: [],
      selectedRepositoryIds: initial.groupContext.repositories.map((repository) => repository.id),
    }))
    .addNode('role', runRole)
    .addNode('input', async (state) => {
      if (!state.pendingInput || !state.activeTaskKey) return {};
      const answer = requestTeamInput(state.pendingInput);
      // Directories carried by an answer bind before the task re-runs, so its
      // repository scope resolves against the extended captured context.
      const bound = answer.directories?.length && delegate.bindGroupDirectories
        ? (await delegate.bindGroupDirectories(state.runId, answer.directories, 'answer'))
          .filter((repository) => !state.groupContext.repositories.some((existing) => existing.id === repository.id))
        : [];
      return {
        pendingInput: null,
        activeTaskKey: null,
        taskAnswers: { [state.activeTaskKey]: answer.answer },
        authorizedCommands: answer.authorizedCommands,
        ...(bound.length ? {
          groupContext: { ...state.groupContext, repositories: [...state.groupContext.repositories, ...bound] },
          selectedRepositoryIds: [...new Set([...state.selectedRepositoryIds, ...bound.map((repository) => repository.id)])],
          projectDirectory: state.projectDirectory || bound[0]!.directory,
        } : {}),
      };
    })
    .addEdge(START, 'start')
    .addEdge('start', 'role')
    .addConditionalEdges('role', (state) => state.pendingInput ? 'input' : state.finished ? END : 'role', ['input', END, 'role'])
    .addEdge('input', 'role');

  return graph.compile({ checkpointer });
}

async function withRepositoryScope(
  request: AgentTeamTaskRequest,
  repositoryIds: readonly string[],
  context: AgentTeamGroupRunContext,
): Promise<AgentTeamTaskRequest> {
  const repositories = selectedRepositories(repositoryIds, context);
  // An empty scope is a valid empty-scope Run state: the role identifies the
  // project directory from context or asks the user; only executor roles are
  // blocked earlier because they cannot launch without a real directory.
  const first = repositories[0];
  if (!first) return request;
  return {
    ...request,
    projectDirectory: first.directory,
    projectInstructions: repositories.flatMap((repository) => repository.projectInstructions),
  };
}

async function runDeveloperAssignments(
  delegate: AgentTeamGroupGraphDelegate,
  state: GroupGraphState,
  base: Omit<AgentTeamTaskRequest, 'projectDirectory'> & { projectDirectory: string },
): Promise<{ result: AgentTeamTaskResult; pendingTaskKey?: string; pendingInputIds: Record<string, string>; fileReferences: Array<{ documentId: string; revision: number; title: string }> }> {
  const assignments = state.assignments;
  const results = await Promise.all(assignments.map(async (assignment) => {
    const taskKey = `group_${state.step}_developer_${assignment.developerId}`;
    const request = await withRepositoryScope({
      ...base,
      intent: assignment.scopeSummary,
      groupMessage: assignment.scopeSummary,
      assignment,
      developerId: assignment.developerId,
      taskDefinition: { ...base.taskDefinition, taskKey, role: 'developer', goal: assignment.scopeSummary },
      pendingInputId: state.taskPendingInputIds[taskKey],
      answer: state.taskAnswers[taskKey],
    }, assignment.repositoryIds?.length ? assignment.repositoryIds : state.selectedRepositoryIds, state.groupContext);
    const result = await delegate.executeTask(request);
    return { taskKey, result, fileReferences: await delegate.documentReferences?.(state.runId, taskKey) ?? [] };
  }));
  const waiting = results.find((item) => item.result.status === 'waiting_for_input');
  const waitingRows = results.filter((item): item is typeof item & { result: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }> } => item.result.status === 'waiting_for_input');
  const pendingInputIds = Object.fromEntries(waitingRows.map((item) => [item.taskKey, item.result.pendingInput.id]));
  const nextQuestion = waitingRows.find((item) => !state.taskAnswers[item.taskKey]) ?? waiting;
  if (nextQuestion?.result.status === 'waiting_for_input') return {
    result: nextQuestion.result,
    pendingTaskKey: nextQuestion.taskKey,
    pendingInputIds,
    fileReferences: [],
  };
  const completed = results.map((item) => item.result).filter((result): result is Extract<AgentTeamTaskResult, { status: 'completed' }> => result.status === 'completed');
  const handoffs = completed.map((result) => result.handoff).filter((handoff): handoff is NonNullable<typeof handoff> => Boolean(handoff));
  const handoff = handoffs[0];
  if (handoffs.some((candidate) => candidate.role !== handoff?.role || candidate.goal !== handoff?.goal)) {
    throw new Error('Parallel Developer assignments requested different follow-up roles.');
  }
  return {
    result: {
      status: 'completed',
      documents: completed.flatMap((result) => result.documents),
      unresolvedIssues: completed.flatMap((result) => result.unresolvedIssues),
      commandIds: completed.flatMap((result) => result.commandIds),
      changedFiles: completed.flatMap((result) => result.changedFiles),
      completedAssignedWork: completed.every((result) => result.completedAssignedWork),
      criterionAssessments: completed.flatMap((result) => result.criterionAssessments),
      message: completed.map((result) => result.message).filter(Boolean).join('\n\n'),
      ...(handoff ? { handoff } : {}),
    },
    pendingInputIds,
    fileReferences: results.flatMap((item) => item.fileReferences),
  };
}

function selectedRepositories(ids: readonly string[], context: AgentTeamGroupRunContext) {
  const selected = ids.length ? new Set(ids) : new Set(context.repositories.map((repository) => repository.id));
  const repositories = context.repositories.filter((repository) => selected.has(repository.id));
  if (repositories.length !== selected.size) throw new Error('A group task requested a repository outside its captured scope.');
  return repositories;
}
