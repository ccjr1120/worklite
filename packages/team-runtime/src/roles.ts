/**
 * Canonical role definition entries for the Worktree Manager and the Planner's
 * Run-level worktree naming convention. The API layer wires these into its
 * AGENT_TEAM_ROLE_INSTRUCTIONS / AGENT_TEAM_ROLE_TOOL_NAMES maps; they live
 * here so the role's contract stays with the orchestration package that
 * consumes its structured output.
 */

/**
 * Worktree Manager tools: read-only process inspection. The role has no bash
 * authorization — every filesystem effect (worktree creation, lane merges,
 * run-branch merge, cleanup) is executed by the runtime from the role's
 * validated structured output, never by the role itself.
 */
export const AGENT_TEAM_WORKTREE_MANAGER_TOOL_NAMES = ['read', 'glob', 'grep', 'process_reference'] as const;

export const AGENT_TEAM_WORKTREE_MANAGER_INSTRUCTIONS = [
  'Read the Planner plan, including its Run-level worktree naming convention, and produce the structured worktree specification for your phase.',
  "Setup phase: output { baseWorktreePath, runBranch, lanes: [{ laneId, worktreePath, branch }] } following the convention — base worktree ../<project-directory-name>-run-<runId> on branch worklite/run-<runId> cut from the target project's current branch, and one lane worktree ../<project-directory-name>-run-<runId>-<laneId> on branch worklite/run-<runId>-<laneId> per development assignment in plan order.",
  "Teardown phase: after the reviewer passes, output { action: 'merge-and-cleanup' } to merge the run branch back into the project's original branch and remove the base worktree, or { action: 'retain', reason } when anything is unresolved.",
  'You have no bash authorization. Never attempt filesystem effects yourself: creation, merging, and cleanup are executed by the runtime from your validated structured output, and invalid output earns exactly one corrective re-invocation with the parse error fed back.',
  'On any merge conflict, failure, or interruption, retain every worktree and branch (never force-remove) and report the worktree paths, branch names, and state as Run evidence.',
].join(' ');

/**
 * Planner instruction addendum: every plan must state the Run-level worktree
 * naming convention that binds the Worktree Manager and every Developer lane.
 */
export const AGENT_TEAM_PLANNER_WORKTREE_CONVENTION_INSTRUCTIONS = [
  "Every plan must state the Run-level worktree naming convention binding all downstream roles: the base worktree at ../<project-directory-name>-run-<runId> on branch worklite/run-<runId>, cut from the target project's current branch; each Developer lane cuts its own sub-worktree ../<project-directory-name>-run-<runId>-<laneId> on branch worklite/run-<runId>-<laneId> from the base worktree and merges back into the run branch through the serialized merge queue; the Worktree Manager merges the run branch back into the project's original branch at teardown.",
  'On any merge conflict, failure, or interruption, all worktrees and branches are retained and reported with their paths, branch names, and state.',
].join(' ');
