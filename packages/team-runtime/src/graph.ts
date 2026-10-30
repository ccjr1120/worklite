import { createHash } from 'node:crypto';
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import type {
  AgentTeamCriterionAssessment,
  AgentTeamDevelopmentAssignment,
  AgentTeamDevelopmentAssignmentInput,
  AgentTeamDocument,
  AgentExecutorCategoryGraphDelegate,
  AgentExecutorCategoryGraphOptions,
  AgentExecutorCategoryGraphResult,
  AgentTeamPendingInput,
  AgentTeamPendingInputAnswer,
  AgentTeamProjectInstructionFile,
  AgentTeamRepairRequest,
  AgentTeamRole,
  AgentTeamRunRequest,
  AgentTeamTargetedRepairRequest,
  AgentTeamTaskDefinition,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
} from './types';

const teamState = Annotation.Root({
  runId: Annotation<string>(),
  intent: Annotation<string>(),
  mode: Annotation<AgentTeamRunRequest['mode']>(),
  projectDirectory: Annotation<string>(),
  outputDirectory: Annotation<string>(),
  scopeRevision: Annotation<number>(),
  projectInstructions: Annotation<readonly AgentTeamProjectInstructionFile[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  documents: Annotation<readonly AgentTeamDocument[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  unresolvedIssues: Annotation<readonly string[]>({
    reducer: (left, right) => [...new Set([...left, ...right])],
    default: () => [],
  }),
  commandIds: Annotation<readonly string[]>({
    reducer: (left, right) => [...new Set([...left, ...right])],
    default: () => [],
  }),
  criterionAssessments: Annotation<readonly AgentTeamCriterionAssessment[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  taskResults: Annotation<Record<string, Extract<AgentTeamTaskResult, { status: 'completed' }>>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  pendingInput: Annotation<AgentTeamPendingInput | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  activeTaskKey: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  taskAnswers: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  taskPendingInputIds: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  repairRound: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  repairInstruction: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  repairRequest: Annotation<AgentTeamRepairRequest | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  continueRepair: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

export type AgentExecutorCategoryGraphState = typeof teamState.State;

const teamV2State = Annotation.Root({
  ...teamState.spec,
  developmentAssignments: Annotation<readonly AgentTeamDevelopmentAssignment[] | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  currentDevelopmentAssignments: Annotation<readonly AgentTeamDevelopmentAssignment[] | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  developmentPendingDeveloperIds: Annotation<readonly string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  developmentActiveDeveloperIds: Annotation<readonly string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  developmentCompletedDeveloperIds: Annotation<readonly string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  developmentPendingInputs: Annotation<Record<string, AgentTeamPendingInput | null>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  developmentActiveTaskKeys: Annotation<Record<string, string | null>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  developmentTaskAnswers: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  developmentTaskPendingInputIds: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  repairRequests: Annotation<readonly AgentTeamTargetedRepairRequest[] | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  repairInstructions: Annotation<Record<string, string>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  dispatchedRepairRound: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
});

export type AgentExecutorCategoryGraphV2State = typeof teamV2State.State;

function completedResultUpdate(result: Extract<AgentTeamTaskResult, { status: 'completed' }>): Partial<AgentExecutorCategoryGraphState> {
  return {
    documents: result.documents,
    unresolvedIssues: result.unresolvedIssues,
    commandIds: result.commandIds,
    criterionAssessments: result.criterionAssessments,
  };
}

function waitingResultUpdate(result: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>, taskKey: string): Partial<AgentExecutorCategoryGraphState> {
  return {
    pendingInput: result.pendingInput,
    activeTaskKey: taskKey,
    taskPendingInputIds: { [taskKey]: result.pendingInput.id },
  };
}

function taskResultUpdate(result: AgentTeamTaskResult, taskKey: string): Partial<AgentExecutorCategoryGraphState> {
  if (result.status === 'waiting_for_input') return waitingResultUpdate(result, taskKey);
  return {
    ...completedResultUpdate(result),
    repairRequest: result.repairRequest,
    taskResults: { [taskKey]: result },
  };
}

type TaskDefinitionOptions = {
  readonly developmentTaskKeys?: readonly string[];
};

function taskDefinition(
  state: AgentExecutorCategoryGraphState | AgentExecutorCategoryGraphV2State,
  role: AgentTeamRole,
  taskKey: string,
  options: TaskDefinitionOptions = {},
): AgentTeamTaskDefinition {
  const isRepair = taskKey.startsWith('repair_');
  const dependencyKeys = taskDependencies(role, state.mode, isRepair, options.developmentTaskKeys ?? ['development']);
  return {
    taskKey,
    role,
    goal: taskGoal(role, isRepair, repairInstructionFor(state, taskKey)),
    dependencyKeys,
    inputDocumentVersions: state.documents.map((document) => ({
      key: document.key,
      contentFingerprint: contentFingerprint(document.content),
    })),
    expectedResultKind: expectedResultKind(role),
    acceptanceCriterionReferences: state.criterionAssessments.map(
      (assessment) => assessment.criterion,
    ),
  };
}

function repairInstructionFor(state: AgentExecutorCategoryGraphState | AgentExecutorCategoryGraphV2State, taskKey: string): string | null {
  const v2 = state as AgentExecutorCategoryGraphV2State;
  if (taskKey.startsWith('repair_')) {
    const developerId = developerIdFromRepairTaskKey(taskKey);
    return v2.repairInstructions?.[developerId] ?? state.repairInstruction ?? null;
  }
  return state.repairInstruction;
}

function taskDependencies(
  role: AgentTeamRole,
  mode: AgentTeamRunRequest['mode'],
  isRepair: boolean,
  developmentTaskKeys: readonly string[] = ['development'],
): string[] {
  if (role === 'planner') return [];
  if (role === 'test_designer') return mode === 'validate_existing' ? [] : ['planning'];
  if (role === 'developer') return ['test_design', ...(isRepair ? ['review'] : [])];
  if (role === 'test_author') {
    return ['test_design', ...developmentTaskKeys, ...(isRepair ? ['review'] : [])];
  }
  if (role === 'test_runner') {
    return [
      ...(mode === 'validate_existing' ? ['test_design'] : ['test_authoring']),
      ...(isRepair ? ['review'] : []),
    ];
  }
  return ['test_execution'];
}

function taskGoal(
  role: AgentTeamRole,
  isRepair: boolean,
  repairInstruction: string | null,
): string {
  const goals: Record<AgentTeamRole, string> = {
    planner: 'Clarify the requested outcome, constraints, acceptance criteria, and parallel development assignments.',
    test_designer: 'Design acceptance-linked scenarios, risks, environments, and proposed checks.',
    developer: 'Implement only the authorized scoped change and report the actual repository result.',
    test_author: 'Author only authorized tests for the implemented behavior using the existing framework.',
    test_runner: 'Run only authorized checks and report their actual outcomes and evidence.',
    reviewer: 'Independently assess changed files and test evidence against the acceptance criteria.',
    'worktree-manager': 'Read the Planner plan and produce the structured worktree specification for this phase; the runtime executes every filesystem effect.',
  };
  return isRepair ? `${goals[role]} Repair instruction: ${repairInstruction ?? ''}` : goals[role];
}

function expectedResultKind(role: AgentTeamRole): string {
  const kinds: Record<AgentTeamRole, string> = {
    planner: 'implementation_plan',
    test_designer: 'test_design',
    developer: 'implementation_record',
    test_author: 'test_automation_record',
    test_runner: 'execution_evidence',
    reviewer: 'review_assessment',
    'worktree-manager': 'worktree_specification',
  };
  return kinds[role];
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function executeTask(
  state: AgentExecutorCategoryGraphState | AgentExecutorCategoryGraphV2State,
  delegate: AgentExecutorCategoryGraphDelegate,
  role: AgentTeamRole,
  taskKey: string,
  developmentTaskKeys?: readonly string[],
): Promise<Partial<AgentExecutorCategoryGraphState>> {
  const request: AgentTeamTaskRequest = {
    runId: state.runId,
    taskDefinition: taskDefinition(state, role, taskKey, developmentTaskKeys ? { developmentTaskKeys } : {}),
    intent: state.intent,
    mode: state.mode,
    projectDirectory: state.projectDirectory,
    outputDirectory: state.outputDirectory,
    scopeRevision: state.scopeRevision,
    projectInstructions: state.projectInstructions,
    upstream: state.documents,
    pendingInputId: state.pendingInput?.id ?? (state.taskAnswers[taskKey] ? state.taskPendingInputIds[taskKey] : undefined),
    answer: state.taskAnswers[taskKey],
    repairInstruction: role === 'developer' && taskKey.startsWith('repair_') ? repairInstructionFor(state, taskKey) ?? undefined : undefined,
    developmentAssignments: (state as AgentExecutorCategoryGraphV2State).developmentAssignments ?? undefined,
  };
  return taskResultUpdate(await delegate.executeTask(request), taskKey);
}

function inputNode() {
  return async (state: AgentExecutorCategoryGraphState): Promise<Partial<AgentExecutorCategoryGraphState>> => {
    if (!state.pendingInput || !state.activeTaskKey) return {};
    const answer = requestTeamInput(state.pendingInput);
    return {
      pendingInput: null,
      activeTaskKey: null,
      taskAnswers: { [state.activeTaskKey]: answer.answer },
    };
  };
}

export function createExecutorCategoryGraph(delegate: AgentExecutorCategoryGraphDelegate, checkpointer: BaseCheckpointSaver | undefined, options: AgentExecutorCategoryGraphOptions = {}) {
  if (options.orchestrationVersion === 4) {
    // Version 4 inserts Worktree Manager setup/teardown stages around the
    // developer fan-out. Its topology is not wired yet; fail loudly rather
    // than silently running a v4 snapshot on the v1 graph.
    throw new Error('Orchestration version 4 graph topology is not implemented.');
  }
  if (options.orchestrationVersion === 3) {
    // Version 3 runs the v2 topology over the fixed lane pool; the Planner's
    // assignment count alone decides how many lanes execute, so dispatch
    // capacity equals the pool size and pending lanes are assignment-driven.
    return createExecutorCategoryGraphV2(delegate, checkpointer, {
      ...options,
      developerIds: DEVELOPER_LANE_IDS,
      developerConcurrency: DEVELOPER_LANE_IDS.length,
    });
  }
  return options.orchestrationVersion === 2
    ? createExecutorCategoryGraphV2(delegate, checkpointer, options)
    : createExecutorCategoryGraphV1(delegate, checkpointer, options);
}

function createExecutorCategoryGraphV1(delegate: AgentExecutorCategoryGraphDelegate, checkpointer: BaseCheckpointSaver | undefined, options: AgentExecutorCategoryGraphOptions) {
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  const graph = new StateGraph(teamState)
    .addNode('planner', async (state) => executeTask(state, delegate, 'planner', 'planning'))
    .addNode('planner_input', inputNode())
    .addNode('test_designer', async (state) => executeTask(state, delegate, 'test_designer', 'test_design'))
    .addNode('test_designer_input', inputNode())
    .addNode('developer', async (state) => executeTask(state, delegate, 'developer', state.repairInstruction ? `repair_${state.repairRound}` : 'development'))
    .addNode('developer_input', inputNode())
    .addNode('test_author', async (state) => executeTask(state, delegate, 'test_author', state.repairInstruction ? `repair_test_authoring_${state.repairRound}` : 'test_authoring'))
    .addNode('test_author_input', inputNode())
    .addNode('test_runner', async (state) => executeTask(state, delegate, 'test_runner', state.repairInstruction ? `repair_test_execution_${state.repairRound}` : 'test_execution'))
    .addNode('test_runner_input', inputNode())
    .addNode('reviewer', async (state) => {
      const result = await executeTask(state, delegate, 'reviewer', state.repairInstruction ? `repair_review_${state.repairRound}` : 'review');
      const requestedRepair = result.repairRequest;
      if (requestedRepair && (requestedRepair.taskKey !== 'development' || !requestedRepair.instruction.trim())) {
        throw new Error('The reviewer requested an invalid repair target.');
      }
      const repairAccepted = Boolean(requestedRepair) && state.repairRound < maxRepairRounds;
      return {
        ...result,
        repairRound: repairAccepted ? state.repairRound + 1 : state.repairRound,
        repairInstruction: repairAccepted ? requestedRepair?.instruction ?? null : null,
        repairRequest: requestedRepair,
        continueRepair: repairAccepted,
      };
    })
    .addNode('reviewer_input', inputNode());

  graph
    .addConditionalEdges(
      START,
      (state) => (state.mode === 'validate_existing' ? 'test_designer' : 'planner'),
      ['planner', 'test_designer'],
    )
    .addConditionalEdges('planner', (state) => (state.pendingInput ? 'planner_input' : 'test_designer'), ['planner_input', 'test_designer'])
    .addEdge('planner_input', 'planner')
    .addConditionalEdges('test_designer', (state) => (state.pendingInput ? 'test_designer_input' : state.mode === 'plan_only' ? END : state.mode === 'validate_existing' ? 'test_runner' : 'developer'), ['test_designer_input', END, 'test_runner', 'developer'])
    .addEdge('test_designer_input', 'test_designer')
    .addConditionalEdges('developer', (state) => (state.pendingInput ? 'developer_input' : 'test_author'), ['developer_input', 'test_author'])
    .addEdge('developer_input', 'developer')
    .addConditionalEdges('test_author', (state) => (state.pendingInput ? 'test_author_input' : 'test_runner'), ['test_author_input', 'test_runner'])
    .addEdge('test_author_input', 'test_author')
    .addConditionalEdges('test_runner', (state) => (state.pendingInput ? 'test_runner_input' : 'reviewer'), ['test_runner_input', 'reviewer'])
    .addEdge('test_runner_input', 'test_runner')
    .addConditionalEdges('reviewer', (state) => {
      if (state.pendingInput) return 'reviewer_input';
      return state.continueRepair ? 'developer' : END;
    }, ['reviewer_input', 'developer', END])
    .addEdge('reviewer_input', 'reviewer');

  return graph.compile({ checkpointer });
}

const RESERVED_DEVELOPER_ID = 'developer';

/** Fixed v3 lane pool; assignments map onto it in Planner output order. */
export const DEVELOPER_LANE_IDS = ['developer', 'developer-2', 'developer-3', 'developer-4'] as const;

function safeGraphNodeName(developerId: string): string {
  return developerId.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function initialTaskKey(developerId: string): string {
  return developerId === RESERVED_DEVELOPER_ID ? 'development' : `development_${developerId}`;
}

function repairTaskKey(round: number, developerId: string): string {
  return developerId === RESERVED_DEVELOPER_ID ? `repair_${round}` : `repair_${round}_${developerId}`;
}

function developerIdFromRepairTaskKey(taskKey: string): string {
  const matches = /^repair_\d+_(.+)$/.exec(taskKey);
  return matches?.[1] ?? RESERVED_DEVELOPER_ID;
}

export function normalizeDevelopmentAssignments(
  value: readonly AgentTeamDevelopmentAssignment[] | undefined,
  developerIds: readonly string[],
): AgentTeamDevelopmentAssignment[] {
  const known = new Set(developerIds);
  if (value === undefined) {
    if (developerIds.length === 1) {
      return [{
        developerId: developerIds[0],
        title: 'Implementation',
        scopeSummary: 'The complete confirmed implementation scope.',
        ownedPaths: ['.'],
      }];
    }
    throw new Error('Parallel development requires explicit assignments for every dispatched Developer.');
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one development assignment is required.');
  }
  const assignments: AgentTeamDevelopmentAssignment[] = [];
  const seenDeveloperIds = new Set<string>();
  const seenPaths: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new Error('A development assignment must be an object.');
    const developerId = typeof item.developerId === 'string' ? item.developerId.trim() : '';
    if (!known.has(developerId)) throw new Error(`Development assignment references unknown Developer ${developerId || '(empty)'}.`);
    if (seenDeveloperIds.has(developerId)) throw new Error(`Developer ${developerId} has more than one development assignment.`);
    seenDeveloperIds.add(developerId);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const scopeSummary = typeof item.scopeSummary === 'string' ? item.scopeSummary.trim() : '';
    if (!title || !scopeSummary) throw new Error('A development assignment requires a title and scope summary.');
    const ownedPaths = normalizeOwnedPaths(item.ownedPaths, developerId);
    for (const path of ownedPaths) {
      if (seenPaths.some((previous) => pathsOverlap(previous, path))) {
        throw new Error(`Development assignments overlap on path ${path}.`);
      }
    }
    seenPaths.push(...ownedPaths);
    assignments.push({ developerId, title, scopeSummary, ownedPaths });
  }
  return assignments;
}

/**
 * v3 Planner assignments carry no developer id; they map onto the fixed lane
 * pool in output order. Omitting assignments runs a single default lane.
 */
export function normalizeDynamicDevelopmentAssignments(
  value: readonly AgentTeamDevelopmentAssignmentInput[] | undefined,
  laneIds: readonly string[],
): AgentTeamDevelopmentAssignment[] {
  if (value === undefined) {
    return [{
      developerId: laneIds[0]!,
      title: 'Implementation',
      scopeSummary: 'The complete confirmed implementation scope.',
      ownedPaths: ['.'],
    }];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('At least one development assignment is required.');
  }
  if (value.length > laneIds.length) {
    throw new Error(`At most ${laneIds.length} parallel development assignments are allowed.`);
  }
  const assignments: AgentTeamDevelopmentAssignment[] = [];
  const seenPaths: Array<{ path: string; repositoryIds?: string[] }> = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') throw new Error('A development assignment must be an object.');
    const developerId = laneIds[index]!;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const scopeSummary = typeof item.scopeSummary === 'string' ? item.scopeSummary.trim() : '';
    if (!title || !scopeSummary) throw new Error('A development assignment requires a title and scope summary.');
    const ownedPaths = normalizeOwnedPaths(item.ownedPaths, developerId);
    const repositoryIds: string[] | undefined = item.repositoryIds?.length
      ? [...new Set<string>(item.repositoryIds)]
      : undefined;
    for (const path of ownedPaths) {
      if (seenPaths.some((previous) => {
        const repositoriesOverlap = !previous.repositoryIds || !repositoryIds
          || previous.repositoryIds.some((repositoryId) => repositoryIds.includes(repositoryId));
        return repositoriesOverlap && pathsOverlap(previous.path, path);
      })) {
        throw new Error(`Development assignments overlap on path ${path}.`);
      }
    }
    seenPaths.push(...ownedPaths.map((path) => ({ path, repositoryIds })));
    assignments.push({ developerId, title, scopeSummary, ownedPaths, ...(repositoryIds ? { repositoryIds } : {}) });
  }
  return assignments;
}

function normalizeOwnedPaths(value: unknown, developerId: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Developer ${developerId} must own at least one non-empty path.`);
  }
  return value.map((candidate) => {
    if (typeof candidate !== 'string') throw new Error(`Developer ${developerId} has an invalid owned path.`);
    const normalized = candidate.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.includes('../') || normalized.startsWith('/')) {
      throw new Error(`Developer ${developerId} has an invalid owned path.`);
    }
    return normalized;
  });
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const shorter = Math.min(leftSegments.length, rightSegments.length);
  return leftSegments.slice(0, shorter).join('/') === rightSegments.slice(0, shorter).join('/');
}

function developerResultUpdate(
  developerId: string,
  taskKey: string,
  result: AgentTeamTaskResult,
): Partial<AgentExecutorCategoryGraphV2State> {
  if (result.status === 'waiting_for_input') {
    return {
      documents: [],
      developmentPendingInputs: { [developerId]: result.pendingInput },
      developmentActiveTaskKeys: { [developerId]: taskKey },
      developmentTaskPendingInputIds: { [taskKey]: result.pendingInput.id },
    };
  }
  return {
    documents: result.documents,
    unresolvedIssues: result.unresolvedIssues,
    commandIds: result.commandIds,
    criterionAssessments: result.criterionAssessments,
    taskResults: { [taskKey]: result },
    developmentPendingInputs: { [developerId]: null },
    developmentActiveTaskKeys: { [developerId]: null },
  };
}

function aggregateDevelopment(
  state: AgentExecutorCategoryGraphV2State,
  assignments: readonly AgentTeamDevelopmentAssignment[],
  repair: boolean,
  round: number,
): Partial<AgentExecutorCategoryGraphV2State> {
  const results = assignments.map(
    (assignment) => state.taskResults[repair ? repairTaskKey(round, assignment.developerId) : initialTaskKey(assignment.developerId)],
  );
  if (results.some((result) => result === undefined)) {
    throw new Error('Development fan-in is missing a completed assignment result.');
  }
  const ownerByPath = new Map<string, string>();
  for (const [index, assignment] of assignments.entries()) {
    for (const path of results[index]!.changedFiles) {
      const owner = ownerByPath.get(path);
      if (owner !== undefined && owner !== assignment.developerId) {
        throw new Error(`Multiple Developers changed the same path: ${path}.`);
      }
      ownerByPath.set(path, assignment.developerId);
    }
  }
  return {
    documents: [
      {
        key: repair ? `repair_implementation_summary_${round}` : 'development_implementation_summary',
        title: repair ? `Repair round ${round} implementation summary` : 'Development implementation summary',
        content: assignments
          .map((assignment, index) => `## ${assignment.title}\n\nDeveloper: ${assignment.developerId}\n\n${assignment.scopeSummary}\n\nChanged files:\n${results[index]!.changedFiles.map((path) => `- ${path}`).join('\n')}`)
          .join('\n\n'),
        producingTaskKey: 'development_join',
        upstreamDocumentKeys: results.flatMap((result) => result!.documents.map((document) => document.key)),
      },
    ],
  };
}

/**
 * Serially recomputes the development fan-out lanes from authoritative state
 * (task results, pending inputs, consumed answers) so parallel Developer
 * branches never write the shared lane lists. Dispatches at most
 * `concurrency - active` pending assignments per pass, primary Developer
 * first, then extra instances in configuration order.
 */
function dispatchDevelopment(
  state: AgentExecutorCategoryGraphV2State,
  developerIds: readonly string[],
): Partial<AgentExecutorCategoryGraphV2State> {
  const update: Partial<AgentExecutorCategoryGraphV2State> = {};
  let round = state.dispatchedRepairRound;
  let assignments = state.currentDevelopmentAssignments;
  if (state.repairRound > round && state.repairRequests?.length) {
    round = state.repairRound;
    const assignmentByDeveloperId = new Map((state.developmentAssignments ?? []).map((assignment) => [assignment.developerId, assignment]));
    assignments = state.repairRequests.map((request) => {
      const assignment = assignmentByDeveloperId.get(request.developerId);
      if (!assignment) throw new Error(`Repair request targets Developer ${request.developerId} without a development assignment.`);
      return assignment;
    });
    update.currentDevelopmentAssignments = assignments;
    update.dispatchedRepairRound = round;
  } else if (!assignments) {
    assignments = state.developmentAssignments ?? [];
    update.currentDevelopmentAssignments = assignments;
  }
  const ordered = [...assignments].sort(
    (left, right) => developerIds.indexOf(left.developerId) - developerIds.indexOf(right.developerId),
  );
  const repair = round > 0;
  const pending: string[] = [];
  const active: string[] = [];
  const completed: string[] = [];
  for (const assignment of ordered) {
    const taskKey = repair ? repairTaskKey(round, assignment.developerId) : initialTaskKey(assignment.developerId);
    if (state.taskResults[taskKey]) {
      completed.push(assignment.developerId);
    } else if (state.developmentPendingInputs[assignment.developerId] || state.developmentTaskAnswers[taskKey]) {
      active.push(assignment.developerId);
    } else {
      pending.push(assignment.developerId);
    }
  }
  return {
    ...update,
    developmentPendingDeveloperIds: pending,
    developmentActiveDeveloperIds: active,
    developmentCompletedDeveloperIds: completed,
  };
}

export function requestTeamInput(pendingInput: AgentTeamPendingInput): AgentTeamPendingInputAnswer {
  return interrupt<AgentTeamPendingInput, AgentTeamPendingInputAnswer>(pendingInput);
}

function createExecutorCategoryGraphV2(
  delegate: AgentExecutorCategoryGraphDelegate,
  checkpointer: BaseCheckpointSaver | undefined,
  options: AgentExecutorCategoryGraphOptions,
) {
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  const developerIds = options.developerIds?.length ? options.developerIds : [RESERVED_DEVELOPER_ID];
  const configuredConcurrency = Math.max(1, Math.min(4, options.developerConcurrency ?? Math.min(developerIds.length, 2)));
  const dynamicLanes = options.orchestrationVersion === 3;
  const graph = new StateGraph(teamV2State)
    .addNode('planner', async (state) => executeDevelopmentTask(state, delegate, 'planner', 'planning', developerIds, dynamicLanes))
    .addNode('planner_input', inputNode())
    .addNode('test_designer', async (state) => executeDevelopmentTask(state, delegate, 'test_designer', 'test_design', developerIds, dynamicLanes))
    .addNode('test_designer_input', inputNode())
    .addNode('development_dispatcher', async (state) => dispatchDevelopment(state, developerIds))
    .addNode('development_join', async (state) => aggregateDevelopment(
      state,
      state.currentDevelopmentAssignments ?? [],
      state.dispatchedRepairRound > 0,
      state.dispatchedRepairRound,
    ))
    .addNode('test_author', async (state) => {
      const taskKey = state.dispatchedRepairRound > 0 ? `repair_test_authoring_${state.dispatchedRepairRound}` : 'test_authoring';
      return executeTask(state, delegate, 'test_author', taskKey, currentDevelopmentTaskKeys(state, state.dispatchedRepairRound > 0));
    })
    .addNode('test_author_input', inputNode())
    .addNode('test_runner', async (state) => {
      const taskKey = state.dispatchedRepairRound > 0 ? `repair_test_execution_${state.dispatchedRepairRound}` : 'test_execution';
      return executeTask(state, delegate, 'test_runner', taskKey, currentDevelopmentTaskKeys(state, state.dispatchedRepairRound > 0));
    })
    .addNode('test_runner_input', inputNode())
    .addNode('reviewer', async (state) => {
      const taskKey = state.dispatchedRepairRound > 0 ? `repair_review_${state.dispatchedRepairRound}` : 'review';
      const result = await executeTask(state, delegate, 'reviewer', taskKey, currentDevelopmentTaskKeys(state, state.dispatchedRepairRound > 0));
      const completed = result.taskResults?.[taskKey];
      const legacyRequest = completed?.repairRequest;
      const requested = completed?.repairRequests
        ?? (legacyRequest ? [{ developerId: RESERVED_DEVELOPER_ID, instruction: legacyRequest.instruction }] : []);
      if (requested.some((request) => !request.instruction.trim() || !developerIds.includes(request.developerId))) {
        throw new Error('The reviewer requested an invalid repair target.');
      }
      if (developerIds.length > 1 && completed?.repairRequest && !completed?.repairRequests) {
        throw new Error('Parallel development repair must target an assigned Developer.');
      }
      const repairAccepted = requested.length > 0 && state.repairRound < maxRepairRounds;
      return {
        ...result,
        repairRound: repairAccepted ? state.repairRound + 1 : state.repairRound,
        repairRequest: legacyRequest,
        repairRequests: repairAccepted ? requested : null,
        repairInstructions: repairAccepted ? Object.fromEntries(requested.map((request) => [request.developerId, request.instruction.trim()])) : {},
        continueRepair: repairAccepted,
      };
    })
    .addNode('reviewer_input', inputNode());

  for (const developerId of developerIds) {
    const name = safeGraphNodeName(developerId);
    const developerNode = `developer_${name}`;
    const inputNodeName = `developer_input_${name}`;
    graph
      .addNode(developerNode, async (state) => {
        const taskKey = state.dispatchedRepairRound > 0
          ? repairTaskKey(state.dispatchedRepairRound, developerId)
          : initialTaskKey(developerId);
        const assignment = (state.currentDevelopmentAssignments ?? []).find((candidate) => candidate.developerId === developerId);
        const pendingInput = state.developmentPendingInputs[developerId] ?? null;
        const pendingInputId = state.developmentTaskPendingInputIds[taskKey];
        const request: AgentTeamTaskRequest = {
          runId: state.runId,
          taskDefinition: taskDefinition(state, 'developer', taskKey),
          intent: state.intent,
          mode: state.mode,
          projectDirectory: state.projectDirectory,
          outputDirectory: state.outputDirectory,
          scopeRevision: state.scopeRevision,
          projectInstructions: state.projectInstructions,
          upstream: state.documents,
          pendingInputId: pendingInput?.id ?? (state.developmentTaskAnswers[taskKey] ? pendingInputId : undefined),
          answer: state.developmentTaskAnswers[taskKey],
          repairInstruction: state.dispatchedRepairRound > 0 ? state.repairInstructions[developerId] : undefined,
          developerId,
          assignment: assignment,
          developmentAssignments: state.developmentAssignments ?? undefined,
          siblingResults: siblingResults(state, developerId),
        };
        return developerResultUpdate(developerId, taskKey, await delegate.executeTask(request));
      })
      .addNode(inputNodeName, async (state) => {
        const pendingInput = state.developmentPendingInputs[developerId];
        if (!pendingInput) return {};
        // Each interrupted input node is resumed individually through a resume
        // map keyed by its LangGraph interrupt id; an input node absent from
        // the map re-interrupts here instead of consuming another lane's answer.
        const answer = requestTeamInput(pendingInput);
        const taskKey = state.developmentActiveTaskKeys[developerId];
        return {
          developmentPendingInputs: { [developerId]: null },
          developmentActiveTaskKeys: { [developerId]: null },
          ...(taskKey ? { developmentTaskAnswers: { [taskKey]: answer.answer } } : {}),
        };
      })
      .addEdge(inputNodeName, developerNode)
      .addConditionalEdges(developerNode, (state) => (
        state.developmentPendingInputs[developerId] ? inputNodeName : 'development_dispatcher'
      ), [inputNodeName, 'development_dispatcher']);
  }

  const developerNodeNames = developerIds.map((id) => `developer_${safeGraphNodeName(id)}`);

  graph
    .addConditionalEdges(
      START,
      (state) => (state.mode === 'validate_existing' ? 'test_designer' : 'planner'),
      ['planner', 'test_designer'],
    )
    .addConditionalEdges('planner', (state) => (state.pendingInput ? 'planner_input' : 'test_designer'), ['planner_input', 'test_designer'])
    .addEdge('planner_input', 'planner')
    .addConditionalEdges('test_designer', (state) => {
      if (state.pendingInput) return 'test_designer_input';
      if (state.mode === 'plan_only') return END;
      if (state.mode === 'validate_existing') return 'test_runner';
      return 'development_dispatcher';
    }, ['test_designer_input', END, 'test_runner', 'development_dispatcher'])
    .addEdge('test_designer_input', 'test_designer')
    .addConditionalEdges('development_dispatcher', (state) => {
      const capacity = Math.max(0, configuredConcurrency - state.developmentActiveDeveloperIds.length);
      const dispatchable = state.developmentPendingDeveloperIds
        .slice(0, capacity)
        .map((developerId) => `developer_${safeGraphNodeName(developerId)}`);
      if (dispatchable.length > 0) return dispatchable;
      return state.developmentPendingDeveloperIds.length === 0 && state.developmentActiveDeveloperIds.length === 0
        ? 'development_join'
        : [];
    }, ['development_join', ...developerNodeNames] as Array<'development_join' | typeof END>)
    .addEdge('development_join', 'test_author')
    .addConditionalEdges('test_author', (state) => (state.pendingInput ? 'test_author_input' : 'test_runner'), ['test_author_input', 'test_runner'])
    .addEdge('test_author_input', 'test_author')
    .addConditionalEdges('test_runner', (state) => (state.pendingInput ? 'test_runner_input' : 'reviewer'), ['test_runner_input', 'reviewer'])
    .addEdge('test_runner_input', 'test_runner')
    .addConditionalEdges('reviewer', (state) => {
      if (state.pendingInput) return 'reviewer_input';
      return state.continueRepair ? 'development_dispatcher' : END;
    }, ['reviewer_input', 'development_dispatcher', END])
    .addEdge('reviewer_input', 'reviewer');

  return graph.compile({ checkpointer });
}

function executeDevelopmentTask(
  state: AgentExecutorCategoryGraphV2State,
  delegate: AgentExecutorCategoryGraphDelegate,
  role: AgentTeamRole,
  taskKey: string,
  developerIds: readonly string[],
  dynamicLanes: boolean,
): Promise<Partial<AgentExecutorCategoryGraphState>> {
  if (role === 'planner') {
    return (async () => {
      const result = await executeTask(state, delegate, role, taskKey);
      if (result.taskResults?.planning) {
        const completed = result.taskResults.planning;
        return {
          ...result,
          developmentAssignments: dynamicLanes
            ? normalizeDynamicDevelopmentAssignments(completed.developmentAssignments, developerIds)
            : normalizeDevelopmentAssignments(
              completed.developmentAssignments as AgentTeamDevelopmentAssignment[] | undefined,
              developerIds,
            ),
        };
      }
      return result;
    })();
  }
  return executeTask(state, delegate, role, taskKey, currentDevelopmentTaskKeys(state, state.dispatchedRepairRound > 0));
}

function currentDevelopmentTaskKeys(state: AgentExecutorCategoryGraphV2State, repair: boolean): string[] {
  return (state.currentDevelopmentAssignments ?? state.developmentAssignments ?? [])
    .map((assignment) => repair ? repairTaskKey(state.dispatchedRepairRound, assignment.developerId) : initialTaskKey(assignment.developerId));
}

function siblingResults(
  state: AgentExecutorCategoryGraphV2State,
  developerId: string,
): Readonly<Record<string, Extract<AgentTeamTaskResult, { status: 'completed' }>>> {
  return Object.fromEntries(Object.entries(state.taskResults).filter(([taskKey]) => taskKey !== initialTaskKey(developerId) && taskKey !== repairTaskKey(state.dispatchedRepairRound, developerId)));
}

export function toGraphResult(state: AgentExecutorCategoryGraphState | AgentExecutorCategoryGraphV2State): AgentExecutorCategoryGraphResult {
  const v2 = state as AgentExecutorCategoryGraphV2State;
  return {
    runId: state.runId,
    intent: state.intent,
    mode: state.mode,
    projectDirectory: state.projectDirectory,
    outputDirectory: state.outputDirectory,
    scopeRevision: state.scopeRevision,
    projectInstructions: state.projectInstructions,
    documents: state.documents,
    unresolvedIssues: state.unresolvedIssues,
    commandIds: state.commandIds,
    criterionAssessments: state.criterionAssessments,
    developmentAssignments: v2.developmentAssignments ?? [],
  };
}
