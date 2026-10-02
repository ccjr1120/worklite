import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type {
  AgentTeamDocument,
  AgentTeamGraphDelegate,
  AgentTeamGraphResult,
  AgentTeamPendingInput,
  AgentTeamRole,
  AgentTeamRunRequest,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
} from './types';

const teamState = Annotation.Root({
  runId: Annotation<string>(),
  intent: Annotation<string>(),
  mode: Annotation<AgentTeamRunRequest['mode']>(),
  projectDirectory: Annotation<string>(),
  scopeRevision: Annotation<number>(),
  documents: Annotation<readonly AgentTeamDocument[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  unresolvedIssues: Annotation<readonly string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  pendingInput: Annotation<AgentTeamPendingInput | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  plannerAnswer: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
});

export type AgentTeamGraphState = typeof teamState.State;

function taskResultUpdate(result: AgentTeamTaskResult): Partial<AgentTeamGraphState> {
  if (result.status === 'waiting_for_input') {
    return { pendingInput: result.pendingInput };
  }
  return {
    pendingInput: null,
    documents: result.documents,
    unresolvedIssues: result.unresolvedIssues,
  };
}

async function runPlanner(state: AgentTeamGraphState, delegate: AgentTeamGraphDelegate) {
  const request: AgentTeamTaskRequest = {
    runId: state.runId,
    taskKey: 'planning',
    role: 'planner',
    intent: state.intent,
    mode: state.mode,
    projectDirectory: state.projectDirectory,
    scopeRevision: state.scopeRevision,
    upstream: state.documents,
    pendingInputId: state.pendingInput?.id,
    answer: state.plannerAnswer || undefined,
  };
  return taskResultUpdate(await delegate.executeTask(request));
}

export function createTeamGraph(delegate: AgentTeamGraphDelegate, checkpointer?: BaseCheckpointSaver) {
  const graph = new StateGraph(teamState)
    .addNode('planner', async (state) => runPlanner(state, delegate))
    .addNode('planner_input', async (state) => {
      if (!state.pendingInput) return {};
      const answer = requestTeamInput(state.pendingInput);
      return { pendingInput: null, plannerAnswer: answer };
    })
    .addNode('test_designer', async (state) => {
      const result = await delegate.executeTask({
        runId: state.runId,
        taskKey: 'test_design',
        role: 'test_designer',
        intent: state.intent,
        mode: state.mode,
        projectDirectory: state.projectDirectory,
        scopeRevision: state.scopeRevision,
        upstream: state.documents,
      });
      return taskResultUpdate(result);
    })
    .addEdge(START, 'planner')
    .addConditionalEdges(
      'planner',
      (state) => (state.pendingInput ? 'planner_input' : 'test_designer'),
      ['planner_input', 'test_designer'],
    )
    .addEdge('planner_input', 'planner')
    .addEdge('test_designer', END);

  return graph.compile({ checkpointer });
}

export function requestTeamInput(pendingInput: AgentTeamPendingInput): string {
  return interrupt<AgentTeamPendingInput, string>(pendingInput);
}

export function toGraphResult(state: AgentTeamGraphState): AgentTeamGraphResult {
  return {
    runId: state.runId,
    intent: state.intent,
    mode: state.mode,
    projectDirectory: state.projectDirectory,
    scopeRevision: state.scopeRevision,
    documents: state.documents,
    unresolvedIssues: state.unresolvedIssues,
  };
}
