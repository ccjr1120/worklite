import { createHash } from 'node:crypto';
import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import {
  DEVELOPER_LANE_IDS,
  normalizeDynamicDevelopmentAssignments,
  requestTeamInput,
} from '@worklite/team-runtime';
import type {
  AgentTeamCriterionAssessment,
  AgentTeamDevelopmentAssignment,
  AgentTeamDocument,
  AgentExecutorCategoryGraphOptions as AgentTeamGraphOptions,
  AgentTeamPendingInput,
  AgentTeamProjectInstructionFile,
  AgentTeamRepairRequest,
  AgentTeamRole,
  AgentTeamRunRequest,
  AgentTeamTargetedRepairRequest,
  AgentTeamTaskDefinition,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
} from '@worklite/team-runtime';
import type { AgentTeamRuntimeRole } from './executor-configuration';

/**
 * App-local graph shell for orchestration v4 and v5. Version 4 keeps the managed
 * Worktree Manager setup/teardown lifecycle. Version 5 uses the setup task for an
 * advisory per-project strategy document; with no runtime worktree state, teardown
 * is skipped and Developer lanes run from the supplied workspace root.
 */

export type AgentTeamWorktreeLane = {
  laneId: string;
  worktreePath: string;
  branch: string;
};

/** The executed Run worktree layout, kept in graph state and mirrored onto the Run row. */
export type AgentTeamWorktreeSetupState = {
  baseWorktreePath: string;
  runBranch: string;
  originalBranch: string;
  lanes: readonly AgentTeamWorktreeLane[];
};

export type AgentTeamLaneWorktree = {
  baseWorktreePath: string;
  runBranch: string;
  worktreePath: string;
  worktreeBranch: string;
};

export type AgentTeamTaskRequestV4 = AgentTeamTaskRequest & {
  laneWorktree?: AgentTeamLaneWorktree;
};

export type AgentTeamGraphV4Delegate = {
  executeTask(request: AgentTeamTaskRequestV4): Promise<AgentTeamTaskResult>;
};

type CompletedTaskResult = Extract<AgentTeamTaskResult, { status: 'completed' }>;

/** Completed task results may carry the executed worktree payload for the graph to consume. */
export type AgentTeamWorktreeTaskResult = CompletedTaskResult & {
  worktreeSetup?: AgentTeamWorktreeSetupState | null;
};

const teamV4State = Annotation.Root({
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
  taskResults: Annotation<Record<string, CompletedTaskResult>>({
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
  worktreeSetup: Annotation<AgentTeamWorktreeSetupState | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  worktreeSetupCompleted: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

export type AgentTeamGraphV4State = typeof teamV4State.State;

function completedResultUpdate(result: CompletedTaskResult): Partial<AgentTeamGraphV4State> {
  return {
    documents: result.documents,
    unresolvedIssues: result.unresolvedIssues,
    commandIds: result.commandIds,
    criterionAssessments: result.criterionAssessments,
  };
}

function waitingResultUpdate(result: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>, taskKey: string): Partial<AgentTeamGraphV4State> {
  return {
    pendingInput: result.pendingInput,
    activeTaskKey: taskKey,
    taskPendingInputIds: { [taskKey]: result.pendingInput.id },
  };
}

function taskResultUpdate(result: AgentTeamTaskResult, taskKey: string): Partial<AgentTeamGraphV4State> {
  if (result.status === 'waiting_for_input') return waitingResultUpdate(result, taskKey);
  return {
    ...completedResultUpdate(result),
    repairRequest: result.repairRequest,
    taskResults: { [taskKey]: result },
  };
}

function taskDefinition(
  state: AgentTeamGraphV4State,
  role: AgentTeamRuntimeRole,
  taskKey: string,
  developmentTaskKeys?: readonly string[],
): AgentTeamTaskDefinition {
  const isRepair = taskKey.startsWith('repair_');
  return {
    taskKey,
    // Bridge until the contracts/db role unions gain 'worktree-manager'.
    role: role as AgentTeamRole,
    goal: taskGoal(role, isRepair, repairInstructionFor(state, taskKey)),
    dependencyKeys: taskDependencies(role, state.mode, isRepair, developmentTaskKeys ?? ['development']),
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

function repairInstructionFor(state: AgentTeamGraphV4State, taskKey: string): string | null {
  if (taskKey.startsWith('repair_')) {
    const developerId = developerIdFromRepairTaskKey(taskKey);
    return state.repairInstructions?.[developerId] ?? state.repairInstruction ?? null;
  }
  return state.repairInstruction;
}

function taskDependencies(
  role: AgentTeamRuntimeRole,
  mode: AgentTeamRunRequest['mode'],
  isRepair: boolean,
  developmentTaskKeys: readonly string[] = ['development'],
): string[] {
  if (role === 'planner') return [];
  if (role === 'test_designer') return mode === 'validate_existing' ? [] : ['planning'];
  if (role === 'worktree-manager') return [mode === 'validate_existing' ? 'test_design' : 'planning'];
  if (role === 'developer') return ['test_design', 'worktree_setup', ...(isRepair ? ['review'] : [])];
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
  role: AgentTeamRuntimeRole,
  isRepair: boolean,
  repairInstruction: string | null,
): string {
  const goals: Record<AgentTeamRuntimeRole, string> = {
    planner: 'Clarify the requested outcome, constraints, acceptance criteria, and parallel development assignments.',
    test_designer: 'Design acceptance-linked scenarios, risks, environments, and proposed checks.',
    developer: 'Implement only the authorized scoped change and report the actual repository result.',
    test_author: 'Author only authorized tests for the implemented behavior using the existing framework.',
    test_runner: 'Run only authorized checks and report their actual outcomes and evidence.',
    reviewer: 'Independently assess changed files and test evidence against the acceptance criteria.',
    'worktree-manager': 'Complete the captured Worktree Manager task exactly as specified by the orchestration version.',
  };
  return isRepair ? `${goals[role]} Repair instruction: ${repairInstruction ?? ''}` : goals[role];
}

function expectedResultKind(role: AgentTeamRuntimeRole): string {
  const kinds: Record<AgentTeamRuntimeRole, string> = {
    planner: 'implementation_plan',
    test_designer: 'test_design',
    developer: 'implementation_record',
    test_author: 'test_automation_record',
    test_runner: 'execution_evidence',
    reviewer: 'review_assessment',
    'worktree-manager': 'Worktree Manager result specified by the orchestration version',
  };
  return kinds[role];
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function executeTask(
  state: AgentTeamGraphV4State,
  delegate: AgentTeamGraphV4Delegate,
  role: AgentTeamRuntimeRole,
  taskKey: string,
  developmentTaskKeys?: readonly string[],
): Promise<Partial<AgentTeamGraphV4State>> {
  const request: AgentTeamTaskRequestV4 = {
    runId: state.runId,
    taskDefinition: taskDefinition(state, role, taskKey, developmentTaskKeys),
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
    developmentAssignments: state.developmentAssignments ?? undefined,
  };
  return taskResultUpdate(await delegate.executeTask(request), taskKey);
}

function inputNode() {
  return async (state: AgentTeamGraphV4State): Promise<Partial<AgentTeamGraphV4State>> => {
    if (!state.pendingInput || !state.activeTaskKey) return {};
    const answer = requestTeamInput(state.pendingInput);
    return {
      pendingInput: null,
      activeTaskKey: null,
      taskAnswers: { [state.activeTaskKey]: answer.answer },
    };
  };
}

const RESERVED_DEVELOPER_ID = 'developer';

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

function developerResultUpdate(
  developerId: string,
  taskKey: string,
  result: AgentTeamTaskResult,
): Partial<AgentTeamGraphV4State> {
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
  state: AgentTeamGraphV4State,
  assignments: readonly AgentTeamDevelopmentAssignment[],
  repair: boolean,
  round: number,
): Partial<AgentTeamGraphV4State> {
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

/** Serially recomputes the fan-out lanes from authoritative state (see team-runtime v2). */
function dispatchDevelopment(state: AgentTeamGraphV4State): Partial<AgentTeamGraphV4State> {
  const developerIds = DEVELOPER_LANE_IDS;
  const update: Partial<AgentTeamGraphV4State> = {};
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
    (left, right) => developerIds.indexOf(left.developerId as (typeof developerIds)[number]) - developerIds.indexOf(right.developerId as (typeof developerIds)[number]),
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

function currentDevelopmentTaskKeys(state: AgentTeamGraphV4State, repair: boolean): string[] {
  return (state.currentDevelopmentAssignments ?? state.developmentAssignments ?? [])
    .map((assignment) => repair ? repairTaskKey(state.dispatchedRepairRound, assignment.developerId) : initialTaskKey(assignment.developerId));
}

function siblingResults(
  state: AgentTeamGraphV4State,
  developerId: string,
): Readonly<Record<string, CompletedTaskResult>> {
  return Object.fromEntries(Object.entries(state.taskResults).filter(([taskKey]) => taskKey !== initialTaskKey(developerId) && taskKey !== repairTaskKey(state.dispatchedRepairRound, developerId)));
}

export function createTeamGraphV4(
  delegate: AgentTeamGraphV4Delegate,
  checkpointer: BaseCheckpointSaver | undefined,
  options: Pick<AgentTeamGraphOptions, 'maxRepairRounds'> = {},
) {
  const maxRepairRounds = options.maxRepairRounds ?? 2;
  const developerIds = DEVELOPER_LANE_IDS;
  const configuredConcurrency = developerIds.length;
  const graph = new StateGraph(teamV4State)
    .addNode('planner', async (state) => {
      const result = await executeTask(state, delegate, 'planner', 'planning');
      if (result.taskResults?.planning) {
        const completed = result.taskResults.planning;
        return {
          ...result,
          developmentAssignments: normalizeDynamicDevelopmentAssignments(completed.developmentAssignments, developerIds),
        };
      }
      return result;
    })
    .addNode('planner_input', inputNode())
    .addNode('test_designer', async (state) => executeTask(state, delegate, 'test_designer', 'test_design', currentDevelopmentTaskKeys(state, state.dispatchedRepairRound > 0)))
    .addNode('test_designer_input', inputNode())
    .addNode('worktree_setup', async (state) => {
      if (state.worktreeSetupCompleted) return {};
      const result = await executeTask(state, delegate, 'worktree-manager', 'worktree_setup');
      const completed = result.taskResults?.worktree_setup as AgentTeamWorktreeTaskResult | undefined;
      if (!completed) return result;
      return {
        ...result,
        worktreeSetup: completed.worktreeSetup ?? null,
        worktreeSetupCompleted: true,
      };
    })
    .addNode('worktree_setup_input', inputNode())
    .addNode('development_dispatcher', async (state) => dispatchDevelopment(state))
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
      if (requested.some((request) => !request.instruction.trim() || !(developerIds as readonly string[]).includes(request.developerId))) {
        throw new Error('The reviewer requested an invalid repair target.');
      }
      if (completed?.repairRequest && !completed?.repairRequests) {
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
    .addNode('reviewer_input', inputNode())
    .addNode('worktree_teardown', async (state) => {
      // No executed setup (non-git project or plan_only/validate_existing without development)
      // means there is nothing to tear down.
      if (!state.worktreeSetup) return {};
      return executeTask(state, delegate, 'worktree-manager', 'worktree_teardown');
    })
    .addNode('worktree_teardown_input', inputNode());

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
        const lane = state.worktreeSetup?.lanes.find((candidate) => candidate.laneId === developerId);
        const laneWorktree: AgentTeamLaneWorktree | undefined = lane && state.worktreeSetup
          ? {
            baseWorktreePath: state.worktreeSetup.baseWorktreePath,
            runBranch: state.worktreeSetup.runBranch,
            worktreePath: lane.worktreePath,
            worktreeBranch: lane.branch,
          }
          : undefined;
        const request: AgentTeamTaskRequestV4 = {
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
          laneWorktree,
        };
        return developerResultUpdate(developerId, taskKey, await delegate.executeTask(request));
      })
      .addNode(inputNodeName, async (state) => {
        const pendingInput = state.developmentPendingInputs[developerId];
        if (!pendingInput) return {};
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
      return 'worktree_setup';
    }, ['test_designer_input', END, 'test_runner', 'worktree_setup'])
    .addEdge('test_designer_input', 'test_designer')
    .addConditionalEdges('worktree_setup', (state) => (
      state.pendingInput ? 'worktree_setup_input' : 'development_dispatcher'
    ), ['worktree_setup_input', 'development_dispatcher'])
    .addEdge('worktree_setup_input', 'worktree_setup')
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
      if (!state.continueRepair) return 'worktree_teardown';
      // Repair before any setup (validate_existing mode) prepares the layout first.
      return state.worktreeSetupCompleted ? 'development_dispatcher' : 'worktree_setup';
    }, ['reviewer_input', 'development_dispatcher', 'worktree_setup', 'worktree_teardown'])
    .addEdge('reviewer_input', 'reviewer')
    .addConditionalEdges('worktree_teardown', (state) => (
      state.pendingInput ? 'worktree_teardown_input' : END
    ), ['worktree_teardown_input', END])
    .addEdge('worktree_teardown_input', 'worktree_teardown');

  return graph.compile({ checkpointer });
}
