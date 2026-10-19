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

Use the shared detail width up to 1200px. The context bar has a keyboard-accessible `Back to work records` link on the left and Save with its progress indicator at the upper right. The form includes the concurrent Run limit, working practice, a protected Team Manager configuration, and every role in the active dynamic directory with provider-grouped model selectors, an execution choice for each work role, and advanced disclosures. Work roles can use the WorkLite Agent with built-in tools, Claude Code, or Codex; Developer remains project-executor-backed. The role list shows configured names and may include custom roles. Any work role, including an initial BMAD/TEA role, may be created, edited or deleted by addressing Team Manager in a group; Team Manager itself remains protected. Developer work may fan out to up to four assignments per Run. Team/repository/role-scoped memory management follows the form. This page has no tabs. Shared semantic tokens govern both light and dark modes.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Save configuration | Report progress on Save; replace the cached Team on success and retain edits and the error on failure. |
| Expand role | Disclose instructions, entry points, Skills, MCP servers and tools without saving. |
| Edit concurrent Run limit | Update `maxConcurrentRuns` locally; the single Save action commits the value and shows local progress. |
| Manage roles | Address Team Manager from a group to create, update or delete a work role; refresh the active role directory and update role choices without changing captured Runs. |
| Manage Team memory | Add, edit or delete a Team/repository/role-scoped memory; each action reports its own progress and errors. |

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain page geometry. |
| Empty | No empty role directory state; the protected Team Manager always exists. |
| No results | No filtered collection on this page. |
| Error | Show the shared recoverable Team load error and retain configuration resource errors in the configuration page. |
| Busy | Save and memory mutations show control-local progress; unrelated page controls remain available. |
| Offline | Inherits shared-states.md. |
| Long content | Dynamic role settings and memory content wrap within the shared detail width; the page scrolls as one surface. |

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
| `agentTeams:team.managerProtected` | Constraint |
| `agentTeams:team.parallelism` | Constraint |
| `agentTeams:team.advanced` | Action |
| `agentTeams:model.default` | Action |
| `agentTeams:model.label` | Constraint |
| `agentTeams:team.executor.label` | Constraint |
| `agentTeams:team.executor.model` / `claude` / `codex` | State |
| `agentTeams:instructions.label` | Constraint |
| `agentTeams:entryPoints.label` / `placeholder` | Constraint / Recovery |
| `agentTeams:skills.label` / `empty` | Constraint / State |
| `agentTeams:mcpServers.label` / `empty` | Constraint / State |
| `agentTeams:tools.label` | Constraint |
| `agentTeams:role.*` | State |
| `agentTeams:memories.title` / `description` / `content` / `repository` / `role` | State / Constraint |
| `agentTeams:memories.add` / `save` / `edit` / `cancel` / `delete` | Action |
| `agentTeams:memories.loading` / `empty` / `loadFailed` / `saveFailed` / `deleteFailed` | State / Recovery |
| `agentTeams:resources.*` | State / Recovery |
| `agentTeams:loading` / `loadFailed` / `unavailable.*` | State / Recovery |

## Accessibility

The context-bar back link and Save action are keyboard reachable with visible focus. Each field keeps its associated label. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

2026-10-19 source comparison: the configuration route renders every active role from the Team response, including custom display names and optional project executors, and exposes Team Manager as protected with an editable model selector (protection means non-deletable and a fixed typed tool set, not a locked model). Work-role create/update/delete remains available through the group Manager; the form keeps its single Save action for settings and editable roles. Team/repository/role memory CRUD remains on this page. Static source comparison only; no browser interaction, build, test suite or deployment was run.

## Changelog

### 2026-10-19

- Made the Team Manager model selector editable: an unconfigured Team Manager model used to fail every Manager Run at execution time, and the selector was the only way to set one.

### 2026-10-19

- Added the protected Team Manager and a dynamic work-role directory whose role CRUD runs through the group conversation. The configuration form reflects the current TeamVersion inputs; captured Runs remain immutable.

### 2026-10-19

- Added a dedicated no-tab configuration page, reachable from the Team work-records page's upper-right action.
