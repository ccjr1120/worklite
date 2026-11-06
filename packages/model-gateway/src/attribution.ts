/**
 * Gateway usage attribution: the platform features a model request can be charged to,
 * and the headers that carry that charge to the Gateway.
 *
 * Attribution is deliberately coarse and total. Every WorkLite code path that reaches
 * the Gateway declares exactly one surface, and the Gateway records a request that
 * declares none as `unattributed` rather than letting it join another surface's
 * totals. `apps/portkey-gateway/src/worklite/attribution.ts` reads these headers and
 * restates the same surface list, because the Gateway is a vendored fork with no
 * dependency on this workspace.
 */
const SURFACES = [
  // Chat's own model loop, including its /summarize call.
  'chat',
  // A Chat-owned project task running in Claude Code or Codex.
  'chat_project_task',
  // A non-Chat Agent execution.
  'agent',
  // A Workflow node: Agent, System One and image nodes.
  'workflow',
  // A Coder role's model loop.
  'coder',
  // A Coder developer role running in Claude Code or Codex.
  'coder_project_task',
  // A Provider connection test issued from WorkLite.
  'provider_test',
  // A client outside WorkLite calling the Gateway's public endpoints directly.
  'external',
  // A request that reached the Gateway without any attribution header.
  'unattributed',
] as const;

export type GatewaySurface = (typeof SURFACES)[number];

export type GatewayCorrelation = {
  surface: GatewaySurface;
  /** Chat conversation (Agent execution) id, for chat and chat_project_task. */
  conversationId?: string;
  /** Recorded Agent invocation (air_..., or aex_... for a direct execution). */
  agentRunId?: string;
  /** Owning Agent execution; shared by its invocation tree. */
  agentExecutionId?: string;
  /** Chat project task id, for chat_project_task. */
  projectTaskId?: string;
  /** Project executor that issued the request, for the two *_project_task surfaces. */
  executor?: 'claude' | 'codex';
  workflowId?: string;
  workflowRunId?: string;
  nodeRunId?: string;
  coderId?: string;
  teamRunId?: string;
  /** Coder role id, for coder and coder_project_task. */
  teamRole?: string;
  teamTaskAttemptId?: string;
  teamOperationKey?: string;
};

/**
 * The coarse `source` label that predates surfaces. It remains in the request-log
 * contract and in the Gateway's `source` column so readers and filters built on it
 * keep working; it is always derived from the surface, so the two cannot disagree.
 */
function logSourceForSurface(surface: GatewaySurface): string {
  if (surface === 'chat' || surface === 'chat_project_task') return 'chat';
  if (surface === 'coder' || surface === 'coder_project_task') return 'coder';
  if (surface === 'workflow') return 'workflow';
  if (surface === 'agent') return 'agent';
  if (surface === 'provider_test') return 'provider_test';
  return 'external';
}

/** Renders a correlation as the request headers the Gateway records it from. */
export function gatewayAttributionHeaders(correlation: GatewayCorrelation | undefined): Record<string, string> {
  if (!correlation) return {};
  const optional: Array<[string, string | undefined]> = [
    ['x-worklite-conversation-id', correlation.conversationId],
    ['x-worklite-agent-run-id', correlation.agentRunId],
    ['x-worklite-agent-execution-id', correlation.agentExecutionId],
    ['x-worklite-project-task-id', correlation.projectTaskId],
    ['x-worklite-executor', correlation.executor],
    ['x-worklite-workflow-id', correlation.workflowId],
    ['x-worklite-workflow-run-id', correlation.workflowRunId],
    ['x-worklite-node-run-id', correlation.nodeRunId],
    ['x-worklite-team-id', correlation.coderId],
    ['x-worklite-team-run-id', correlation.teamRunId],
    ['x-worklite-team-role', correlation.teamRole],
    ['x-worklite-team-task-attempt-id', correlation.teamTaskAttemptId],
    ['x-worklite-team-operation-key', correlation.teamOperationKey],
  ];
  return {
    'x-worklite-surface': correlation.surface,
    'x-worklite-log-source': logSourceForSurface(correlation.surface),
    ...Object.fromEntries(optional.flatMap(([name, value]) => {
      const trimmed = value?.trim();
      return trimmed ? [[name, trimmed]] : [];
    })),
  };
}
