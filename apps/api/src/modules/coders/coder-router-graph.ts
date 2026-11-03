import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  AgentTeamTaskStoppedError,
  type AgentTeamGroupRunContext,
  type AgentTeamPendingInput,
  type AgentTeamProjectInstructionFile,
  type AgentTeamRoleId,
  type AgentTeamTaskRequest,
  type AgentTeamTaskResult,
  type AgentTeamRouterAssignment,
} from '@worklite/team-runtime';
import { CODER_ROUTER_ROLE } from './coder-configuration';

function requestTeamInput(pendingInput: AgentTeamPendingInput) {
  return interrupt<AgentTeamPendingInput, { answer: string; directories?: readonly string[] }>(pendingInput);
}

const MAX_ROUTER_TURNS = 16;
const MAX_ROUTER_TASKS = 32;

export type AgentTeamGroupGraphInitial = {
  runId: string;
  intent: string;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  groupContext: AgentTeamGroupRunContext;
  orchestrationVersion: 12;
  writeCapableRoles?: readonly AgentTeamRoleId[];
};

type RouterTaskHistory = {
  id: string;
  round: number;
  taskKey: string;
  role: AgentTeamRoleId;
  status: 'completed' | 'failed' | 'stopped' | 'waiting_for_input';
  summary: string;
  fileReferences?: Array<{ documentId: string; revision: number; title: string }>;
  changedFiles?: string[];
  unresolvedIssues?: string[];
  pendingInput?: AgentTeamPendingInput;
};

type GroupGraphState = {
  runId: string;
  intent: string;
  projectDirectory: string;
  outputDirectory: string;
  scopeRevision: number;
  projectInstructions: readonly AgentTeamProjectInstructionFile[];
  groupContext: AgentTeamGroupRunContext;
  currentRole: AgentTeamRoleId;
  currentGoal: string;
  currentMessage: string;
  taskContextSummary: string;
  fileReferences: Array<{ documentId: string; revision: number; title: string }>;
  selectedRepositoryIds: readonly string[];
  step: number;
  taskPendingInputIds: Record<string, string>;
  taskAnswers: Record<string, string>;
  pendingInput: AgentTeamPendingInput | null;
  activeTaskKey: string | null;
  finished: boolean;
  routerLimitReached: boolean;
  routerRound: number;
  routerAssignments: readonly AgentTeamRouterAssignment[];
  routerHistory: readonly RouterTaskHistory[];
  routerTaskCount: number;
};

export type AgentTeamGroupGraphState = GroupGraphState;

export type AgentTeamGroupGraphDelegate = {
  executeTask(request: AgentTeamTaskRequest): Promise<AgentTeamTaskResult>;
  documentReferences?(runId: string, taskKey: string): Promise<Array<{ documentId: string; revision: number; title: string }>>;
  recoverTaskAttempt?(runId: string, taskKey: string): Promise<{
    role: AgentTeamRoleId;
    status: RouterTaskHistory['status'];
    summary: string;
    fileReferences?: Array<{ documentId: string; revision: number; title: string }>;
    changedFiles?: string[];
    unresolvedIssues?: string[];
    pendingInput?: AgentTeamPendingInput;
  } | null>;
  bindGroupDirectories?(runId: string, directories: readonly string[], source: 'answer' | 'role'): Promise<AgentTeamGroupRunContext['repositories']>;
};

const groupState = Annotation.Root({
  runId: Annotation<string>(),
  intent: Annotation<string>(),
  projectDirectory: Annotation<string>(),
  outputDirectory: Annotation<string>(),
  scopeRevision: Annotation<number>(),
  projectInstructions: Annotation<readonly AgentTeamProjectInstructionFile[]>({ reducer: (_left, right) => right, default: () => [] }),
  groupContext: Annotation<AgentTeamGroupRunContext>(),
  currentRole: Annotation<AgentTeamRoleId>(),
  currentGoal: Annotation<string>(),
  currentMessage: Annotation<string>(),
  taskContextSummary: Annotation<string>(),
  fileReferences: Annotation<Array<{ documentId: string; revision: number; title: string }>>({ reducer: (_left, right) => right, default: () => [] }),
  selectedRepositoryIds: Annotation<readonly string[]>({ reducer: (_left, right) => right, default: () => [] }),
  step: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  taskPendingInputIds: Annotation<Record<string, string>>({ reducer: (left, right) => ({ ...left, ...right }), default: () => ({}) }),
  taskAnswers: Annotation<Record<string, string>>({ reducer: (left, right) => ({ ...left, ...right }), default: () => ({}) }),
  pendingInput: Annotation<AgentTeamPendingInput | null>({ reducer: (_left, right) => right, default: () => null }),
  activeTaskKey: Annotation<string | null>({ reducer: (_left, right) => right, default: () => null }),
  finished: Annotation<boolean>({ reducer: (_left, right) => right, default: () => false }),
  routerLimitReached: Annotation<boolean>({ reducer: (_left, right) => right, default: () => false }),
  routerRound: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  routerAssignments: Annotation<readonly AgentTeamRouterAssignment[]>({ reducer: (_left, right) => right, default: () => [] }),
  routerHistory: Annotation<readonly RouterTaskHistory[]>({ reducer: (_left, right) => right, default: () => [] }),
  routerTaskCount: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
});

export function createAgentTeamGroupGraph(
  delegate: AgentTeamGroupGraphDelegate,
  checkpointer: BaseCheckpointSaver | undefined,
  initial: AgentTeamGroupGraphInitial,
) {
  const runRole = async (state: GroupGraphState): Promise<Partial<GroupGraphState>> => {
    const nextStep = state.step + 1;
    if (state.currentRole === CODER_ROUTER_ROLE && state.routerAssignments.length > 0) {
      return runRouterAssignments(delegate, state, initial, nextStep);
    }
    const routerTurn = state.currentRole === CODER_ROUTER_ROLE;
    const taskKey = routerTurn ? `group_router_${state.routerRound}` : `group_${state.step}_${state.currentRole}`;
    const routerInput = routerTurn ? formatRouterInput(state) : undefined;
    const common = {
      runId: state.runId,
      intent: state.currentGoal,
      projectDirectory: state.projectDirectory,
      outputDirectory: state.outputDirectory,
      scopeRevision: state.scopeRevision,
      projectInstructions: state.projectInstructions,
      groupContext: state.groupContext,
      groupMessage: routerInput ?? state.currentMessage,
      taskContextSummary: routerInput ?? state.taskContextSummary,
      fileReferences: state.fileReferences,
      upstream: [],
      taskDefinition: {
        taskKey,
        role: state.currentRole,
        goal: state.currentGoal,
        dependencyKeys: [],
        inputDocumentVersions: [],
        expectedResultKind: routerTurn
          ? 'message, question, and a Router decision to finish or dispatch specific role assignments'
          : 'message, question, and work result returned to Router; no direct handoff',
        acceptanceCriterionReferences: [],
      },
      pendingInputId: state.taskPendingInputIds[`group_${state.step}_${state.currentRole}`],
      answer: state.taskAnswers[`group_${state.step}_${state.currentRole}`],
    } satisfies Omit<AgentTeamTaskRequest, 'projectDirectory'> & { projectDirectory: string };
    const execution = {
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
    // the registration extends the captured scope so later Router assignments validate against it.
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

    if (state.currentRole === CODER_ROUTER_ROLE) {
      if (!result.routerPlan) throw new Error('Router completed without a routerPlan.');
      if (result.routerPlan.action === 'finish') {
        return {
          step: nextStep,
          currentRole: CODER_ROUTER_ROLE,
          currentGoal: state.intent,
          currentMessage: result.message?.trim() || '已完成当前任务。',
          taskContextSummary: result.message?.trim() ?? '',
          fileReferences: execution.fileReferences,
          routerAssignments: [],
          finished: true,
          pendingInput: null,
          activeTaskKey: null,
          ...scopeUpdate,
        };
      }
      if (state.routerRound >= MAX_ROUTER_TURNS || state.routerTaskCount + result.routerPlan.assignments.length > MAX_ROUTER_TASKS) {
        return {
          step: nextStep,
          currentRole: CODER_ROUTER_ROLE,
          routerLimitReached: true,
          routerAssignments: [],
          finished: true,
          pendingInput: null,
          activeTaskKey: null,
          ...scopeUpdate,
        };
      }
      const scopedIds = new Set(scopeContext.repositories.map((repository) => repository.id));
      for (const assignment of result.routerPlan.assignments) {
        if (assignment.repositoryIds?.some((id) => !scopedIds.has(id))) throw new Error(`Router assignment ${assignment.id} requested a repository outside this Run scope.`);
      }
      return {
        step: nextStep,
        currentRole: CODER_ROUTER_ROLE,
        currentGoal: state.intent,
        currentMessage: state.intent,
        taskContextSummary: result.message?.trim() ?? '',
        fileReferences: execution.fileReferences,
        routerAssignments: result.routerPlan.assignments,
        routerRound: state.routerRound + 1,
        routerTaskCount: state.routerTaskCount + result.routerPlan.assignments.length,
        routerHistory: state.routerHistory,
        pendingInput: null,
        activeTaskKey: null,
        finished: false,
        ...scopeUpdate,
      };
    }
    if (result.routerPlan) {
      throw new Error('A work role must return its result to Router instead of choosing the next role.');
    }
    return {
      step: nextStep,
      currentRole: CODER_ROUTER_ROLE,
      currentGoal: state.intent,
      currentMessage: state.intent,
      taskContextSummary: result.message?.trim() ?? '',
      fileReferences: execution.fileReferences,
      routerAssignments: [],
      pendingInput: null,
      activeTaskKey: null,
      finished: false,
      ...scopeUpdate,
    };
  };

  const graph = new StateGraph(groupState)
    .addNode('start', async () => ({
      runId: initial.runId,
      intent: initial.intent,
      projectDirectory: initial.projectDirectory,
      outputDirectory: initial.outputDirectory,
      scopeRevision: initial.scopeRevision,
      projectInstructions: initial.projectInstructions,
      groupContext: initial.groupContext,
      currentRole: CODER_ROUTER_ROLE,
      currentGoal: initial.intent,
      currentMessage: initial.groupContext.initialMessage,
      taskContextSummary: '',
      fileReferences: [],
      selectedRepositoryIds: initial.groupContext.repositories.map((repository) => repository.id),
      routerRound: 0,
      routerAssignments: [],
      routerHistory: [],
      routerTaskCount: 0,
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

function formatRouterInput(state: GroupGraphState): string {
  const recent = state.routerHistory.map((item) => ({
    id: item.id,
    round: item.round,
    role: item.role,
    status: item.status,
    summary: item.summary.slice(0, 1_200),
    fileReferences: item.fileReferences,
    changedFiles: item.changedFiles?.slice(0, 20),
    unresolvedIssues: item.unresolvedIssues?.slice(0, 10),
  }));
  return JSON.stringify({
    originalGoal: state.intent,
    requestedRole: state.groupContext.requestedRole ?? null,
    continuation: state.groupContext.continuation ?? null,
    authorizedRepositories: state.groupContext.repositories.map(({ id, name, directory }) => ({ id, name, directory })),
    completedAndPendingRoleResults: recent,
    ...(state.groupContext.continuation ? {
      continuationContext: {
        role: state.groupContext.continuation.role,
        taskKey: state.groupContext.continuation.taskKey,
        goal: state.groupContext.continuation.goal,
        savedProgress: state.groupContext.continuation.savedProgress,
        fileReferences: state.groupContext.continuation.fileReferences,
      },
    } : {}),
    maxAdditionalRoleTasks: Math.max(0, MAX_ROUTER_TASKS - state.routerTaskCount),
  });
}

async function runRouterAssignments(
  delegate: AgentTeamGroupGraphDelegate,
  state: GroupGraphState,
  initial: AgentTeamGroupGraphInitial,
  nextStep: number,
): Promise<Partial<GroupGraphState>> {
  const round = state.routerRound - 1;
  const assignmentById = new Map(state.routerAssignments.map((assignment) => [assignment.id, assignment]));
  const history = [...state.routerHistory];
  const current = () => history.filter((item) => item.round === round);
  const entry = (id: string) => current().find((item) => item.id === id);
  const taskKeyFor = (id: string) => `group_${round}_${id}`;

  if (delegate.recoverTaskAttempt) {
    const recovered = await Promise.all(state.routerAssignments
      .filter((assignment) => !entry(assignment.id))
      .map(async (assignment) => ({ assignment, attempt: await delegate.recoverTaskAttempt!(state.runId, taskKeyFor(assignment.id)) })));
    for (const { assignment, attempt } of recovered) {
      if (!attempt) continue;
      history.push({
        id: assignment.id,
        round,
        taskKey: taskKeyFor(assignment.id),
        role: attempt.role,
        status: attempt.status,
        summary: attempt.summary,
        ...(attempt.fileReferences ? { fileReferences: attempt.fileReferences } : {}),
        ...(attempt.changedFiles ? { changedFiles: attempt.changedFiles } : {}),
        ...(attempt.unresolvedIssues ? { unresolvedIssues: attempt.unresolvedIssues } : {}),
        ...(attempt.pendingInput ? { pendingInput: attempt.pendingInput } : {}),
      });
    }
  }

  for (const assignment of state.routerAssignments) {
    if (entry(assignment.id)) continue;
    const failedDependency = assignment.dependencyIds.find((dependencyId) => {
      const dependency = entry(dependencyId);
      return dependency && (dependency.status === 'failed' || dependency.status === 'stopped');
    });
    if (failedDependency) history.push({
      id: assignment.id,
      round,
      taskKey: taskKeyFor(assignment.id),
      role: assignment.role,
      status: 'failed',
      summary: `Not started because dependency ${failedDependency} did not complete.`,
    });
  }

  const ready = state.routerAssignments.filter((assignment) => {
    const prior = entry(assignment.id);
    const resumableQuestion = prior?.status === 'waiting_for_input' && Boolean(state.taskAnswers[taskKeyFor(assignment.id)]);
    if (prior && !resumableQuestion) return false;
    return assignment.dependencyIds.every((dependencyId) => entry(dependencyId)?.status === 'completed');
  });
  const selected: AgentTeamRouterAssignment[] = [];
  const selectedScopes: Array<{ ids: Set<string>; writes: boolean }> = [];
  for (const assignment of ready) {
    const ids = new Set(assignment.repositoryIds?.length ? assignment.repositoryIds : state.selectedRepositoryIds);
    const writes = initial.writeCapableRoles?.includes(assignment.role) ?? false;
    const conflicts = selectedScopes.some((scope) => (writes || scope.writes) && [...ids].some((id) => scope.ids.has(id)));
    if (conflicts) continue;
    selected.push(assignment);
    selectedScopes.push({ ids, writes });
  }

  let updatedContext = state.groupContext;
  let selectedRepositoryIds = state.selectedRepositoryIds;
  let projectDirectory = state.projectDirectory;
  const results = await Promise.all(selected.map(async (assignment) => {
    const taskKey = taskKeyFor(assignment.id);
    const dependencyKeys = assignment.dependencyIds.map(taskKeyFor);
    const dependencyHistory = current().filter((item) => assignment.dependencyIds.includes(item.id));
    const request = await withRepositoryScope({
      runId: state.runId,
      intent: assignment.goal,
      projectDirectory,
      outputDirectory: state.outputDirectory,
      scopeRevision: state.scopeRevision,
      projectInstructions: state.projectInstructions,
      groupContext: updatedContext,
      groupMessage: assignment.goal,
      taskContextSummary: JSON.stringify({ assignmentId: assignment.id, dependencies: dependencyHistory }),
      fileReferences: dependencyHistory.flatMap((item) => item.fileReferences ?? []),
      upstream: [],
      taskDefinition: {
        taskKey,
        role: assignment.role,
        goal: assignment.goal,
        dependencyKeys,
        inputDocumentVersions: [],
        expectedResultKind: 'message, documents, changed files, unresolved issues, and a result returned to Router',
        acceptanceCriterionReferences: [],
      },
      pendingInputId: state.taskPendingInputIds[taskKey],
      answer: state.taskAnswers[taskKey],
    }, assignment.repositoryIds?.length ? assignment.repositoryIds : state.selectedRepositoryIds, updatedContext);
    try {
      const result = await delegate.executeTask(request);
      const fileReferences = await delegate.documentReferences?.(state.runId, taskKey) ?? [];
      if (result.status === 'waiting_for_input') return { assignment, taskKey, result, fileReferences };
      return { assignment, taskKey, result, fileReferences };
    } catch (error) {
      return {
        assignment,
        taskKey,
        stopped: error instanceof AgentTeamTaskStoppedError,
        error: error instanceof Error ? error.message : String(error),
        fileReferences: [],
      };
    }
  }));

  const newDirectories = results.flatMap(({ result }) => result?.status === 'completed' ? (result.repositoryDirectories ?? []) : []);
  if (newDirectories.length && delegate.bindGroupDirectories) {
    const bound = await delegate.bindGroupDirectories(state.runId, newDirectories, 'role');
    updatedContext = { ...updatedContext, repositories: [...updatedContext.repositories, ...bound.filter((repository) => !updatedContext.repositories.some((existing) => existing.id === repository.id))] };
    selectedRepositoryIds = [...new Set([...selectedRepositoryIds, ...bound.map((repository) => repository.id)])];
    projectDirectory = projectDirectory || bound[0]?.directory || '';
  }

  for (const item of results) {
    const priorIndex = history.findIndex((row) => row.round === round && row.id === item.assignment.id);
    const result = item.result;
    const next: RouterTaskHistory = result?.status === 'waiting_for_input'
      ? { id: item.assignment.id, round, taskKey: item.taskKey, role: item.assignment.role, status: 'waiting_for_input', summary: result.pendingInput.question, fileReferences: item.fileReferences, pendingInput: result.pendingInput }
      : item.stopped
        ? { id: item.assignment.id, round, taskKey: item.taskKey, role: item.assignment.role, status: 'stopped', summary: item.error ?? 'Stopped by user.' }
        : item.error
          ? { id: item.assignment.id, round, taskKey: item.taskKey, role: item.assignment.role, status: 'failed', summary: item.error }
          : {
            id: item.assignment.id,
            round,
            taskKey: item.taskKey,
            role: item.assignment.role,
            status: 'completed',
            summary: result?.status === 'completed'
              ? result.message ?? result.documents.map((document) => document.title).join(', ') ?? 'Completed.'
              : 'Completed.',
            fileReferences: item.fileReferences,
            changedFiles: result?.status === 'completed' ? result.changedFiles : [],
            unresolvedIssues: result?.status === 'completed' ? result.unresolvedIssues : [],
          };
    if (priorIndex < 0) history.push(next);
    else history[priorIndex] = next;
  }

  const currentHistory = current();
  const unanswered = currentHistory.find((item) => item.status === 'waiting_for_input' && !state.taskAnswers[item.taskKey]);
  if (unanswered?.pendingInput) {
    return {
      step: nextStep,
      currentRole: CODER_ROUTER_ROLE,
      routerHistory: history,
      pendingInput: unanswered.pendingInput,
      activeTaskKey: unanswered.taskKey,
      taskPendingInputIds: { [unanswered.taskKey]: unanswered.pendingInput.id },
      finished: false,
      groupContext: updatedContext,
      selectedRepositoryIds,
      projectDirectory,
    };
  }

  const terminal = state.routerAssignments.every((assignment) => {
    const status = entry(assignment.id)?.status;
    return status === 'completed' || status === 'failed' || status === 'stopped';
  });
  if (terminal) {
    return {
      step: nextStep,
      currentRole: CODER_ROUTER_ROLE,
      routerAssignments: [],
      routerHistory: history,
      pendingInput: null,
      activeTaskKey: null,
      finished: false,
      groupContext: updatedContext,
      selectedRepositoryIds,
      projectDirectory,
    };
  }

  if (!selected.length && !unanswered) throw new Error('Router assignments made no progress; check dependencies and repository scopes.');
  return {
    step: nextStep,
    currentRole: CODER_ROUTER_ROLE,
    routerHistory: history,
    pendingInput: null,
    activeTaskKey: null,
    finished: false,
    groupContext: updatedContext,
    selectedRepositoryIds,
    projectDirectory,
  };
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

function selectedRepositories(ids: readonly string[], context: AgentTeamGroupRunContext) {
  const selected = ids.length ? new Set(ids) : new Set(context.repositories.map((repository) => repository.id));
  const repositories = context.repositories.filter((repository) => selected.has(repository.id));
  if (repositories.length !== selected.size) throw new Error('A group task requested a repository outside its captured scope.');
  return repositories;
}
