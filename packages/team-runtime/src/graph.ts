import { createHash } from 'node:crypto';
import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type {
  AgentTeamCriterionAssessment,
  AgentTeamDocument,
  AgentTeamGraphDelegate,
  AgentTeamGraphOptions,
  AgentTeamGraphResult,
  AgentTeamPendingInput,
  AgentTeamPendingInputAnswer,
  AgentTeamProjectInstructionFile,
  AgentTeamRole,
  AgentTeamRunRequest,
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
  authorizedCommands: Annotation<readonly string[]>({
    reducer: (left, right) => [...new Set([...left, ...right])],
    default: () => [],
  }),
  projectInstructions: Annotation<readonly AgentTeamProjectInstructionFile[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  documents: Annotation<readonly AgentTeamDocument[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  unresolvedIssues: Annotation<readonly string[]>({
    reducer: (left, right) => [...left, ...right],
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
  repairRequest: Annotation<Extract<AgentTeamTaskResult, { status: 'completed' }>['repairRequest']>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),
  continueRepair: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

export type AgentTeamGraphState = typeof teamState.State;

function completedResultUpdate(result: Extract<AgentTeamTaskResult, { status: 'completed' }>): Partial<AgentTeamGraphState> {
  return {
    pendingInput: null,
    activeTaskKey: null,
    documents: result.documents,
    unresolvedIssues: result.unresolvedIssues,
    commandIds: result.commandIds,
    criterionAssessments: result.criterionAssessments,
    repairRequest: result.repairRequest,
  };
}

function waitingResultUpdate(result: Extract<AgentTeamTaskResult, { status: 'waiting_for_input' }>, taskKey: string): Partial<AgentTeamGraphState> {
  return {
    pendingInput: result.pendingInput,
    activeTaskKey: taskKey,
    taskPendingInputIds: { [taskKey]: result.pendingInput.id },
  };
}

function taskResultUpdate(result: AgentTeamTaskResult, taskKey: string): Partial<AgentTeamGraphState> {
  if (result.status === 'waiting_for_input') return waitingResultUpdate(result, taskKey);
  return {
    ...completedResultUpdate(result),
    taskResults: { [taskKey]: result },
  };
}

function taskDefinition(
  state: AgentTeamGraphState,
  role: AgentTeamRole,
  taskKey: string,
): AgentTeamTaskDefinition {
  const isRepair = taskKey.startsWith('repair_');
  const dependencyKeys = taskDependencies(role, state.mode, isRepair);
  return {
    taskKey,
    role,
    goal: taskGoal(role, isRepair, state.repairInstruction),
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

function taskDependencies(
  role: AgentTeamRole,
  mode: AgentTeamRunRequest['mode'],
  isRepair: boolean,
): string[] {
  if (role === 'planner') return [];
  if (role === 'test_designer') return mode === 'validate_existing' ? [] : ['planning'];
  if (role === 'developer') return ['test_design', ...(isRepair ? ['review'] : [])];
  if (role === 'test_author') {
    return ['test_design', 'development', ...(isRepair ? ['review'] : [])];
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
    planner: 'Clarify the requested outcome, constraints, acceptance criteria, and implementation tasks.',
    test_designer: 'Design acceptance-linked scenarios, risks, environments, and proposed checks.',
    developer: 'Implement only the authorized scoped change and report the actual repository result.',
    test_author: 'Author only authorized tests for the implemented behavior using the existing framework.',
    test_runner: 'Run only authorized checks and report their actual outcomes and evidence.',
    reviewer: 'Independently assess changed files and test evidence against the acceptance criteria.',
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
  };
  return kinds[role];
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function executeTask(
  state: AgentTeamGraphState,
  delegate: AgentTeamGraphDelegate,
  role: AgentTeamRole,
  taskKey: string,
): Promise<Partial<AgentTeamGraphState>> {
  const request: AgentTeamTaskRequest = {
    runId: state.runId,
    taskDefinition: taskDefinition(state, role, taskKey),
    intent: state.intent,
    mode: state.mode,
    projectDirectory: state.projectDirectory,
    outputDirectory: state.outputDirectory,
    scopeRevision: state.scopeRevision,
    authorizedCommands: state.authorizedCommands,
    projectInstructions: state.projectInstructions,
    upstream: state.documents,
    pendingInputId: state.pendingInput?.id ?? (state.taskAnswers[taskKey] ? state.taskPendingInputIds[taskKey] : undefined),
    answer: state.taskAnswers[taskKey],
    repairInstruction: role === 'developer' && taskKey.startsWith('repair_') ? state.repairInstruction ?? undefined : undefined,
  };
  return taskResultUpdate(await delegate.executeTask(request), taskKey);
}

function inputNode() {
  return async (state: AgentTeamGraphState): Promise<Partial<AgentTeamGraphState>> => {
    if (!state.pendingInput || !state.activeTaskKey) return {};
    const answer = requestTeamInput(state.pendingInput);
    return {
      pendingInput: null,
      activeTaskKey: null,
      taskAnswers: { [state.activeTaskKey]: answer.answer },
      authorizedCommands: answer.authorizedCommands,
    };
  };
}

export function createTeamGraph(delegate: AgentTeamGraphDelegate, checkpointer: BaseCheckpointSaver | undefined, options: AgentTeamGraphOptions = {}) {
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

export function requestTeamInput(pendingInput: AgentTeamPendingInput): AgentTeamPendingInputAnswer {
  return interrupt<AgentTeamPendingInput, AgentTeamPendingInputAnswer>(pendingInput);
}

export function toGraphResult(state: AgentTeamGraphState): AgentTeamGraphResult {
  return {
    runId: state.runId,
    intent: state.intent,
    mode: state.mode,
    projectDirectory: state.projectDirectory,
    outputDirectory: state.outputDirectory,
    scopeRevision: state.scopeRevision,
    authorizedCommands: state.authorizedCommands,
    projectInstructions: state.projectInstructions,
    documents: state.documents,
    unresolvedIssues: state.unresolvedIssues,
    commandIds: state.commandIds,
    criterionAssessments: state.criterionAssessments,
  };
}
