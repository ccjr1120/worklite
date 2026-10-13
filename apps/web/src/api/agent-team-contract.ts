import type {
  AgentTeamConversationRunStateView,
  AgentTeamConversationView,
  AgentTeamRunView,
  AgentTeamView,
  UpdateAgentTeamRequest,
} from '@worklite/contracts';

// Parallel-Run + Worktree Manager view contract (implementation plan §5),
// declared locally until @worklite/contracts publishes these fields from the
// packages lane. Every name here must stay exactly aligned with §5 so the
// consolidated merge is a pure import swap.

export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export type TeamConcurrencyView = AgentTeamView & {
  maxConcurrentRuns?: number;
};

export type UpdateTeamConcurrencyRequest = UpdateAgentTeamRequest & {
  maxConcurrentRuns?: number;
};

export type TeamRunWorktreeEvidence = {
  worktreeBasePath?: string | null;
  runBranch?: string | null;
};

export type TeamRunDetailView = AgentTeamRunView & TeamRunWorktreeEvidence;

// Every non-terminal Run (queued included), in creation order so queued FIFO
// order is visible. Replaces the single activeRun field.
export type TeamConversationRunsView = Omit<AgentTeamConversationView, 'activeRun'> & {
  activeRuns?: AgentTeamConversationRunStateView[];
};
