# Agent Team Configuration

## Route

`/agent-teams/:teamId/configuration`. One built-in Team has no Team collection or creation/deletion surface.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/web/src/routes/agent-teams/$teamId.tsx`
- `apps/web/src/routes/agent-teams/$teamId.configuration.tsx`
- `apps/web/src/features/agent-teams/team-detail.tsx`
- `apps/web/src/features/agent-teams/team-memories.tsx`

## Purpose

Configure the built-in Agent Team and manage its working practice and memories.

## Primary Task

Save the Team configuration. Action budget: one Save action; edits remain a draft until the user commits them.

## Layout

Use the shared detail width up to 1200px. The context bar has a keyboard-accessible `Back to work records` link on the left and Save with its progress indicator at the upper right. The form leads with the concurrent Run limit, then the protected Team Manager pinned at the top as a Chat-style section that combines its provider-grouped model selector, its working practice, and Team/repository-scoped memory management — the Manager owns working practice and memories the way Chat owns its prompt and memories. Every work role in the active dynamic directory follows with a provider-grouped model selector and an execution choice: the WorkLite Agent with built-in tools, Claude Code, or Codex; Developer remains project-executor-backed and may fan out to up to four assignments per Run. The role list shows configured names and may include custom roles. Role instructions, entry points, Skills, MCP servers and tool sets are managed by addressing Team Manager in a group, not on this page. Team Manager protection means non-deletable with a fixed typed tool set; its model remains configurable. This page has no tabs. Shared semantic tokens govern both light and dark modes.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Save configuration | Report progress on Save; replace the cached Team on success and retain edits and the error on failure. |
| Edit concurrent Run limit | Update `maxConcurrentRuns` locally; the single Save action commits the value and shows local progress. |
| Manage roles | Address Team Manager from a group to create, update or delete a work role, or to change its instructions, entry points, Skills, MCP servers or tools; refresh the active role directory and update role choices without changing captured Runs. |
| Manage Team memory | Add, edit or delete a Team/repository-scoped memory owned by the Team Manager; each action reports its own progress and errors. |

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain page geometry. |
| Empty | No empty role directory state; the protected Team Manager always exists. |
| No results | No filtered collection on this page. |
| Error | Show the shared recoverable Team load error and retain configuration resource errors in the configuration page. |
| Busy | Save and memory mutations show control-local progress; unrelated page controls remain available. |
| Offline | Inherits shared-states.md. |
| Long content | Role settings and memory content wrap within the shared detail width; the page scrolls as one surface. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:configuration.title` | State |
| `agentTeams:configuration.backToRecords` | Action |
| `agentTeams:team.updated` | State |
| `agentTeams:team.save` | Action |
| `agentTeams:team.saving` | State |
| `agentTeams:team.saveFailed` | Recovery |
| `agentTeams:team.process` | State |
| `agentTeams:team.processId` / `processVersion` | State |
| `agentTeams:team.maxConcurrentRuns.label` / `hint` | Constraint |
| `agentTeams:team.workingPractice.label` / `hint` | Constraint |
| `agentTeams:team.roles` | State |
| `agentTeams:team.parallelism` | Constraint |
| `agentTeams:model.default` | Action |
| `agentTeams:model.label` | Constraint |
| `agentTeams:team.executor.label` | Constraint |
| `agentTeams:team.executor.model` / `claude` / `codex` | State |
| `agentTeams:role.*` | State |
| `agentTeams:memories.title` / `description` / `content` / `repository` | State / Constraint |
| `agentTeams:memories.add` / `save` / `edit` / `cancel` / `delete` | Action |
| `agentTeams:memories.loading` / `empty` / `loadFailed` / `saveFailed` / `deleteFailed` | State / Recovery |
| `agentTeams:resources.*` | State / Recovery |
| `agentTeams:loading` / `loadFailed` / `unavailable.*` | State / Recovery |

## Accessibility

The context-bar back link and Save action are keyboard reachable with visible focus. Each field keeps its associated label. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

2026-10-19 source comparison after the Manager-owned practice and memory redesign: the Team save path accepts Team Manager model changes (protection covers deletion and the fixed typed tool set only, enforced in `agent-team-configuration.service.ts`). The page pins the Team Manager at the top as a Chat-style section combining its model selector, working practice and Team/repository-scoped memory management; work roles keep model and executor choices only, and instructions, entry points, Skills, MCP servers and tool sets are managed through Team Manager conversation. The runtime injects captured working practice and a bounded memory projection (50 entries or 6000 characters, Team and repository scopes, legacy role-scoped entries excluded) into Team Manager turns only; work-role contexts no longer carry working practice or memories. The advanced disclosure, the managerProtected note and their locale keys are removed. Static source comparison only; no browser interaction, build, test suite or deployment was run.

## Changelog

### 2026-10-19

- Pinned the Team Manager at the top of the page as a Chat-style section combining its model, working practice and Team/repository-scoped memory management; working practice and memories now belong to the Manager and are injected into its turns only, and the Team save path accepts Manager model changes.
- Reduced work roles to model and executor choices: instructions, entry points, Skills, MCP servers and tool sets moved to Team Manager conversation management, and the advanced disclosure, its copy keys and the obsolete manager-protected note are removed.

### 2026-10-19

- Made the Team Manager model selector editable: an unconfigured Team Manager model used to fail every Manager Run at execution time, and the selector was the only way to set one.

### 2026-10-19

- Added the protected Team Manager and a dynamic work-role directory whose role CRUD runs through the group conversation. The configuration form reflects the current TeamVersion inputs; captured Runs remain immutable.

### 2026-10-19

- Added a dedicated no-tab configuration page, reachable from the Team work-records page's upper-right action.
