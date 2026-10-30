/**
 * Usage attribution as the Gateway sees it: the surfaces a request can be charged to,
 * the headers that carry them, and the one function that decides a request's surface.
 *
 * The Gateway is a vendored fork with no dependency on the WorkLite workspace, so the
 * surface list is restated here. `packages/model-gateway/src/attribution.ts` emits
 * these headers and must stay in step with this list.
 */
const GATEWAY_SURFACES = [
  'chat',
  'chat_project_task',
  'agent',
  'workflow',
  'executor_category',
  'executor_category_project_task',
  'provider_test',
  'external',
  'unattributed',
] as const;

export type GatewaySurface = (typeof GATEWAY_SURFACES)[number];

export type GatewayAttribution = {
  surface: GatewaySurface;
  source: string | null;
  conversationId: string | null;
  projectTaskId: string | null;
  executor: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  nodeRunId: string | null;
  executorCategoryId: string | null;
  teamRunId: string | null;
  teamRole: string | null;
  teamTaskAttemptId: string | null;
  teamOperationKey: string | null;
};

export const UNATTRIBUTED_SURFACE: GatewaySurface = 'unattributed';

function isSurface(value: string | null): value is GatewaySurface {
  return value !== null && (GATEWAY_SURFACES as readonly string[]).includes(value);
}

/**
 * Maps a legacy `x-worklite-log-source` onto a surface for a caller that does not yet
 * send `x-worklite-surface`. 'chat' resolves to the Chat model loop and never to a
 * project task: the legacy header cannot distinguish them, and choosing the finer
 * surface would be a guess.
 */
function surfaceForSource(source: string | null): GatewaySurface | null {
  if (!source) return null;
  if (isSurface(source) && source !== 'unattributed') return source;
  if (source === 'proxy') return 'external';
  return null;
}

type HeaderReader = (name: string) => string | null;

/**
 * Reads attribution from a request's headers. The surface is always decided: an
 * explicit `x-worklite-surface`, else the legacy source, else 'unattributed' — so an
 * unattributed request is visible as its own group instead of being absent.
 */
export function readAttribution(header: HeaderReader): GatewayAttribution {
  const source = header('x-worklite-log-source');
  const declared = header('x-worklite-surface');
  return {
    surface: isSurface(declared) ? declared : surfaceForSource(source) ?? UNATTRIBUTED_SURFACE,
    source,
    conversationId: header('x-worklite-conversation-id'),
    projectTaskId: header('x-worklite-project-task-id'),
    executor: header('x-worklite-executor'),
    workflowId: header('x-worklite-workflow-id'),
    workflowRunId: header('x-worklite-workflow-run-id'),
    nodeRunId: header('x-worklite-node-run-id'),
    executorCategoryId: header('x-worklite-team-id'),
    teamRunId: header('x-worklite-team-run-id'),
    teamRole: header('x-worklite-team-role'),
    teamTaskAttemptId: header('x-worklite-team-task-attempt-id'),
    teamOperationKey: header('x-worklite-team-operation-key'),
  };
}

/** The dimensions `requestStats` can group its attribution breakdown by. */
const GATEWAY_STATS_GROUP_BYS = ['surface', 'conversation', 'executor', 'executor_category', 'workflow', 'team_run', 'node_run'] as const;

export type GatewayStatsGroupBy = (typeof GATEWAY_STATS_GROUP_BYS)[number];

export function isStatsGroupBy(value: unknown): value is GatewayStatsGroupBy {
  return typeof value === 'string' && (GATEWAY_STATS_GROUP_BYS as readonly string[]).includes(value);
}
