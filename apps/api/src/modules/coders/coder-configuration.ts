import type { AgentTeamMode, AgentTeamRole, AgentTeamRoleId } from '@worklite/contracts';
import { getBmadTeaProcessManifest } from '@worklite/team-runtime';

export const COMPANY_CODER_ID = 'company_coder';
export const QUICK_CODER_ID = 'quick_coder';
export const CODER_PROCESS_ID = 'bmad-tea';
export const CODER_PROCESS_VERSION = '1';

// Retired Coder IDs for backward compatibility with historical data
export const RETIRED_AGENT_TEAM_IDS = ['agent_team_application'] as const;

export const DEFAULT_PROJECT_GIT_POLICY = 'Follow the user\'s explicit instructions and the target repository\'s applicable instructions before team defaults. Inspect the actual branch and worktree state before choosing a strategy. Use the repository\'s required worktree location when one is needed; do not assume main or .wt. Preserve unrelated changes and protected branches. Commit, merge, push, and clean up only when authorized by the request and applicable repository instructions.';
export const DEFAULT_COMPANY_PROJECT_GIT_POLICY = DEFAULT_PROJECT_GIT_POLICY;
export const DEFAULT_DIRECT_GIT_POLICY = DEFAULT_PROJECT_GIT_POLICY;

// Mirrors CompanyCoder's Planner requirement that the plan itself commit to branch and
// worktree orchestration, so the Implementer follows a decision instead of improvising one.
// Display name of QuickCoder's implementation role; its role id stays `executor`.
export const DIRECT_IMPLEMENTER_DISPLAY_NAME = 'Implementer';

export const DEFAULT_PLANNER_EVIDENCE_INSTRUCTIONS = [
  'Scale investigation and plan detail to the request. Identify the decisions and evidence needed, use a relevant available code index for structural discovery when it covers the target, check coverage and freshness, and read the relevant source directly when evidence is missing or stale. Do not repeat unsuccessful index queries or searches that have already answered the question.',
  'Use bounded searches and excerpts. Stop investigating when there is enough evidence to deliver an actionable result; record non-blocking assumptions and gaps rather than repeatedly searching or asking routine questions. Do not repeatedly write or search memories during the same task. Report progress when investigation is prolonged.',
  'Do not invent evidence. If a material decision remains blocked after reasonable read-only investigation, explain what is missing, what you tried and its impact; ask a focused question only if the answer is needed. Preserve already granted approvals and continue independent work.',
].join('\n');

export const DIRECT_PLANNER_INSTRUCTIONS = 'Understand the requested goal and preserve user intent. Clarify only material missing information. Inspect the authorized project read-only without editing code, then produce a concrete execution plan for the Implementer. You may ask for plan confirmation using the existing waiting_for_input question mechanism before handing off. Hand off to role executor (the Implementer) with a specific, actionable goal describing the plan to implement.'
  + '\n\nWhen Git orchestration is needed, plan it in accordance with the user\'s instructions, repository rules and actual state. Do not assume a base branch, worktree path, commit or merge is required. Include the necessary decisions in the handoff.'
  + '\n\nWhen the implementation can split safely into independent, non-overlapping pieces of work, decide the split yourself instead of leaving it to the Implementer: return up to four developmentAssignments in the handoff, each with a title, scopeSummary, non-overlapping ownedPaths and optional repositoryIds; include branch and worktree decisions only when needed and authorized. WorkLite runs each assignment as its own Implementer process in parallel using this same captured Implementer configuration. Only split when the pieces are truly independent; a single assignment (or none) is correct for most Direct work.'
  + `\n\n${DEFAULT_PLANNER_EVIDENCE_INSTRUCTIONS}`;

export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

// The Dispatcher is a server-owned built-in role. Its stable id is the default
// v10 Run recipient; Chat never invents or selects this id.
// The Dispatcher is an optional role. Coders may include it as the default entry point.
// If absent, the Planner becomes the entry point.
export const CODER_DISPATCHER_ROLE = 'dispatcher';

// Existing role ids stay stable; server-created v8-v9 work roles receive dynamic ids captured by each TeamVersion.
export type AgentTeamRuntimeRole = AgentTeamRoleId;

export function agentTeamContractRole(role: AgentTeamRuntimeRole): AgentTeamRoleId {
  return role;
}

export const CODER_ROLES: readonly AgentTeamRuntimeRole[] = [
  'dispatcher',
  'planner',
  'test_designer',
  'developer',
  'test_author',
  'test_runner',
  'reviewer',
  'worktree-manager',
];

export const CODER_ROLE_TOOL_NAMES: Partial<Record<string, readonly string[]>> = {
  dispatcher: ['read', 'glob', 'grep', 'process_reference'],
  planner: ['read', 'glob', 'grep', 'process_reference'],
  test_designer: ['read', 'glob', 'grep', 'process_reference'],
  developer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'],
  test_author: ['read', 'write', 'glob', 'grep', 'process_reference'],
  test_runner: ['bash', 'read', 'write', 'glob', 'grep'],
  reviewer: ['bash', 'read', 'glob', 'grep', 'process_reference'],
  // The v5-v9 Worktree Manager plans and reports; Coders choose Git operations.
  'worktree-manager': ['read', 'glob', 'grep', 'process_reference'],
  // QuickCoder's Implementer mirrors the Developer's tool access.
  executor: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'],
};

export const CODER_ROLE_INSTRUCTIONS: Partial<Record<string, string>> = {
  dispatcher: 'Decide how this Run should proceed from the original request and the actual project context: plan only, validate existing behavior, or implement and validate. Inspect without modifying project files, state one-sentence reasoning, and hand off to the correct role. Ask one focused question only when the request is ambiguous and may change production code.',
  planner: `Clarify the software goal, preserve the user intent, inspect the authorized project context, and produce an implementation plan that downstream roles can execute.\n\n${DEFAULT_PLANNER_EVIDENCE_INSTRUCTIONS}`,
  test_designer: 'Translate the intent and plan into a test design with explicit evidence requirements. State what each planned check can and cannot establish.',
  developer: 'Implement the smallest direct change that satisfies the intent and authorized plan. Preserve repository instructions and report changes and gaps accurately.',
  test_author: 'Author only the tests required by the confirmed test design and authorized execution scope.',
  test_runner: 'Execute the declared checks through the available command tool, preserve their exact evidence, and distinguish command success from criterion completion.',
  reviewer: 'Independently assess the implementation and test evidence against the original intent. Request scoped repair only when concrete evidence shows a defect.',
  'worktree-manager': 'For v4 Runs, follow the captured worktree setup and teardown instructions. For v5–v9 work, provide advisory per-project Git strategy recommendations only; Coders inspect the actual repository state and choose their own Git operations.',
  // QuickCoder only: the engine-backed Implementer carries out the Planner's handed-off plan.
  executor: 'Implement the Planner\'s handed-off plan in the authorized project. Follow the project\'s own repository instructions and the Coder Git policy. Report the changes you made and any gaps between the plan and what you could complete.',
};

// Determine a Coder's entry role based on its configured roles. The Dispatcher is the default
// entry point when present; if absent, the Planner is the entry point instead.
export function teamEntryRole(team: { id: string; roles: ReadonlyArray<{ role: string }> }): AgentTeamRoleId {
  if (team.roles.some((r) => r.role === CODER_DISPATCHER_ROLE)) {
    return CODER_DISPATCHER_ROLE;
  }
  if (team.roles.some((r) => r.role === 'planner')) {
    return 'planner';
  }
  // This should not happen if schema validation is correct, but fail fast if it does.
  throw new Error(`Coder ${team.id} has no Dispatcher or Planner role; cannot determine entry role.`);
}

// A directly addressed role bypasses the Dispatcher. Validation roles stay on
// the validation path; any other named role keeps the v9 free handoff chain.
export function initialAgentTeamModeForRole(role: AgentTeamRoleId): AgentTeamMode {
  if (role === CODER_DISPATCHER_ROLE) return 'plan_only';
  if (role === 'test_designer' || role === 'test_runner' || role === 'reviewer') return 'validate_existing';
  return 'implement_and_validate';
}

export function agentTeamModeEntryRole(mode: AgentTeamMode): 'planner' | 'test_designer' {
  return mode === 'validate_existing' ? 'test_designer' : 'planner';
}

export function agentTeamModeAllowsRole(mode: AgentTeamMode, role: AgentTeamRoleId): boolean {
  if (role === CODER_DISPATCHER_ROLE || role === 'executor-manager') return false;
  if (mode === 'plan_only') return role === 'planner';
  if (mode === 'validate_existing') return role === 'planner' || role === 'test_designer' || role === 'test_runner' || role === 'reviewer';
  return true;
}

export function agentTeamEntryPoints(role: AgentTeamRuntimeRole): readonly string[] {
  const manifest = getBmadTeaProcessManifest();
  const roleEntryPoints = manifest.entryPoints[role as AgentTeamRole];
  if (roleEntryPoints) return roleEntryPoints;
  if (CODER_ROLE_INSTRUCTIONS[role]) return [];
  return [...new Set(Object.values(manifest.entryPoints).flat())];
}

export function isValidAgentTeamRoleId(value: unknown): value is AgentTeamRuntimeRole {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
