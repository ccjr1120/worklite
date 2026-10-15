/** Canonical Team strategy guidance. Captured v4 snapshots keep their managed
 * worktree lifecycle; new v5 snapshots use advisory per-project Git choices.
 */

/** Worktree Manager tools remain read-only; v5 strategy plans do not execute Git effects. */
export const AGENT_TEAM_WORKTREE_MANAGER_TOOL_NAMES = ['read', 'glob', 'grep', 'process_reference'] as const;

export const AGENT_TEAM_WORKTREE_MANAGER_INSTRUCTIONS = [
  'For orchestration v4 snapshots only, follow the captured managed setup and teardown contract and return its structured worktree output; the runtime executes those Git effects.',
  'For orchestration v5, inspect the Planner assignments and produce an advisory per-project strategy document. Recommend current-branch work, a feature branch, or a worktree for that project only when useful; Developers inspect repository state and choose their own Git operations.',
  'A v5 recommendation creates no branch or worktree and does not authorize or perform merges or cleanup. Do not require a Git strategy for every project or wrap the full workspace in one worktree.',
].join(' ');

/** Planner guidance retained with the orchestration-version context. */
export const AGENT_TEAM_PLANNER_WORKTREE_CONVENTION_INSTRUCTIONS = [
  'For orchestration v4 snapshots only, state the captured Run-level worktree naming and merge convention for downstream roles.',
  'For orchestration v5, identify relevant project roots and keep assignment paths workspace-relative and non-overlapping. Do not require branches or worktrees; the Worktree Manager gives advice and Developers choose Git operations after inspecting each project.',
].join(' ');
