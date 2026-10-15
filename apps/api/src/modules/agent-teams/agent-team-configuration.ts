import type { AgentTeamRole } from '@worklite/contracts';
import { getBmadTeaProcessManifest } from '@worklite/team-runtime';

export const BUILT_IN_AGENT_TEAM_ID = 'agent_team_bmad_tea';
export const AGENT_TEAM_PROCESS_ID = 'bmad-tea';
export const AGENT_TEAM_PROCESS_VERSION = '1';

// Upper bound for TeamConfiguration.maxConcurrentRuns (default 3).
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
export const MAX_CONCURRENT_RUNS_LIMIT = 8;

// Orchestration v4 introduced the worktree-manager role. The contracts/db role unions gain
// 'worktree-manager' with the packages lane; the runtime widens locally until that merge lands.
export type AgentTeamRuntimeRole = AgentTeamRole | 'worktree-manager';

// Bridge until the contracts/db unions accept 'worktree-manager'.
export function agentTeamContractRole(role: AgentTeamRuntimeRole): AgentTeamRole {
  return role as AgentTeamRole;
}

export const AGENT_TEAM_ROLES: readonly AgentTeamRuntimeRole[] = [
  'planner',
  'test_designer',
  'developer',
  'test_author',
  'test_runner',
  'reviewer',
  'worktree-manager',
];

export const AGENT_TEAM_ROLE_TOOL_NAMES: Record<AgentTeamRuntimeRole, readonly string[]> = {
  planner: ['read', 'glob', 'grep', 'process_reference'],
  test_designer: ['read', 'glob', 'grep', 'process_reference'],
  developer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'],
  test_author: ['read', 'write', 'glob', 'grep', 'process_reference'],
  test_runner: ['bash', 'read', 'write', 'glob', 'grep'],
  reviewer: ['read', 'glob', 'grep', 'process_reference'],
  // The v5 Worktree Manager plans and reports; Developer executors choose Git operations.
  'worktree-manager': ['read', 'glob', 'grep', 'process_reference'],
};

export const AGENT_TEAM_ROLE_INSTRUCTIONS: Record<AgentTeamRuntimeRole, string> = {
  planner: 'Clarify the software goal, preserve the user intent, inspect the authorized project context, and produce an implementation plan that downstream roles can execute.',
  test_designer: 'Translate the intent and plan into a test design with explicit evidence requirements. State what each planned check can and cannot establish.',
  developer: 'Implement the smallest direct change that satisfies the intent and authorized plan. Preserve repository instructions and report changes and gaps accurately.',
  test_author: 'Author only the tests required by the confirmed test design and authorized execution scope.',
  test_runner: 'Execute the declared checks through the available command tool, preserve their exact evidence, and distinguish command success from criterion completion.',
  reviewer: 'Independently assess the implementation and test evidence against the original intent. Request scoped repair only when concrete evidence shows a defect.',
  'worktree-manager': 'For v4 Runs, follow the captured worktree setup and teardown instructions. For v5 Runs, provide advisory per-project Git strategy recommendations only; Developers inspect the actual repository state and choose their own Git operations.',
};

export function agentTeamEntryPoints(role: AgentTeamRuntimeRole): readonly string[] {
  return getBmadTeaProcessManifest().entryPoints[role] ?? [];
}
