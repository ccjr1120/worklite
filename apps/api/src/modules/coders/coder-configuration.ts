import type { AgentTeamRole, AgentTeamRoleId } from '@worklite/contracts';
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

// Display name of QuickCoder's implementation role; its role id is `implementer`.
export const DIRECT_IMPLEMENTER_DISPLAY_NAME = 'Implementer';

export const DEFAULT_PLANNER_EVIDENCE_INSTRUCTIONS = [
  'Scale investigation and plan detail to the request. Identify the decisions and evidence needed, use a relevant available code index for structural discovery when it covers the target, check coverage and freshness, and read the relevant source directly when evidence is missing or stale. Do not repeat unsuccessful index queries or searches that have already answered the question.',
  'Use bounded searches and excerpts. Stop investigating when there is enough evidence to deliver an actionable result; record non-blocking assumptions and gaps rather than repeatedly searching or asking routine questions. Do not repeatedly write or search memories during the same task. Report progress when investigation is prolonged.',
  'Do not invent evidence. If a material decision remains blocked after reasonable read-only investigation, explain what is missing, what you tried and its impact; ask a focused question only if the answer is needed. Preserve already granted approvals and continue independent work.',
].join('\n');

export const DIRECT_PLANNER_INSTRUCTIONS = 'Understand the requested goal and preserve user intent. Clarify only material missing information. Inspect the authorized project read-only without editing code, then return a concrete plan and relevant evidence to Router. Do not choose the next role, ask for plan confirmation, or hand work to another role.'
  + `\n\n${DEFAULT_PLANNER_EVIDENCE_INSTRUCTIONS}`;

export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

// Server-owned coordinator for every newly created group Run.
export const CODER_ROUTER_ROLE = 'router';

// Existing role ids stay stable; server-created v8-v9 work roles receive dynamic ids captured by each TeamVersion.
export type AgentTeamRuntimeRole = AgentTeamRoleId;

export function agentTeamContractRole(role: AgentTeamRuntimeRole): AgentTeamRoleId {
  return role;
}

export const CODER_ROLES: readonly AgentTeamRuntimeRole[] = [
  'router',
  'planner',
  'test_designer',
  'developer',
  'test_author',
  'test_runner',
  'reviewer',
];

export const CODER_ROLE_TOOL_NAMES: Partial<Record<string, readonly string[]>> = {
  router: ['read', 'glob', 'grep', 'process_reference'],
  planner: ['read', 'glob', 'grep', 'process_reference'],
  test_designer: ['read', 'glob', 'grep', 'process_reference'],
  developer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'],
  test_author: ['read', 'write', 'glob', 'grep', 'process_reference'],
  test_runner: ['bash', 'read', 'write', 'glob', 'grep'],
  reviewer: ['bash', 'read', 'glob', 'grep', 'process_reference'],
  // QuickCoder's Implementer mirrors the Developer's tool access.
  implementer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'],
};

export const CODER_ROLE_INSTRUCTIONS: Partial<Record<string, string>> = {
  router: 'Coordinate this task continuously. Use only captured roles and the authorized repository scope. Decide whether to answer directly, ask one material question, or assign one or more concrete role tasks. Every role result returns to Router; make the next decision from the persisted results. Never hand work directly from one role to another. Do not use fixed role order or infer the implementation role from configuration order. Do not dispatch deployment or other protected operations unless the user authorized them and the selected role has the required capability.',
  planner: `Clarify the software goal, preserve the user intent, inspect the authorized project context, and produce an implementation plan that downstream roles can execute.\n\n${DEFAULT_PLANNER_EVIDENCE_INSTRUCTIONS}`,
  test_designer: 'Translate the intent and plan into a test design with explicit evidence requirements. State what each planned check can and cannot establish.',
  developer: 'Implement the smallest direct change that satisfies the intent and authorized plan. Preserve repository instructions and report changes and gaps accurately.',
  test_author: 'Author only the tests required by the confirmed test design and authorized execution scope.',
  test_runner: 'Execute the declared checks through the available command tool, preserve their exact evidence, and distinguish command success from criterion completion.',
  reviewer: 'Independently assess the implementation and test evidence against the original intent. Request scoped repair only when concrete evidence shows a defect.',
  // QuickCoder's Implementer is one of Router's configurable work roles.
  implementer: 'Complete the concrete task Router assigned in the authorized project. Follow the project\'s own repository instructions and the Coder Git policy. Report the changes you made, the evidence you gathered, and any remaining gaps to Router.',
};

export function teamEntryRole(_team: { id: string; roles: ReadonlyArray<{ role: string }> }): AgentTeamRoleId {
  return CODER_ROUTER_ROLE;
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
