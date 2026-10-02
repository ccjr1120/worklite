# Agent Team Detail

## Route

`/agent-teams/:teamId`

The first release has one built-in Team. The workspace shell and Chat Bot starter link directly to its detail route; there is no Team collection page or creation/deletion action.

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
- `apps/web/src/features/agent-teams/team-detail.tsx`

## Purpose

Configure the built-in software Team and start an authorized Team run for one project goal.

## Primary Task

Start a Team run from an intent, project directory, mode, and optional exact command grants. Action budget: one — the Start action submits all run inputs and navigates to the resulting run.

Saving Team configuration is a separate goal with its own single Save action. Changing a field never silently saves; the Save control is the one activation point for configuration.

## Layout

The page uses the full Workspace page width with a `1200px` maximum. A two-column desktop grid places the compact Start Run form beside process and authorization metadata; the columns stack below `1024px`. Team roles follow as a vertical list of unframed role cards. Each card contains its model, instructions, process entry points, Skill selections, MCP selections, and tool selections in one lightweight panel. The cards become a single column below `768px`. Long entry-point paths and instructions wrap or scroll within their controls rather than widening the page.

## Interaction Contract

| Action | Trigger and behavior |
| --- | --- |
| Start run | The Start control shows its own spinner, is disabled while submitting, and navigates to `/agent-team-runs/:runId` on success. A failure is announced beside the control; inputs remain editable for recovery. |
| Save Team configuration | The Save control shows its own spinner and is disabled while saving. The returned Team replaces the query cache. A failure is announced beside the control and local edits remain available. |
| Edit a role field | Editing updates local configuration only and marks the configuration unsaved. No field requires a separate apply control. |
| Select model | Selecting a public model or the Team default updates that role locally. The model list comes from the Providers query. |
| Select Skills or MCP servers | Checkbox selection updates the role locally; the Save action is the sole commit control. |
| Select role tools | Checkbox selection updates the role locally; the Save action is the sole commit control. |
| Open from Chat Bot | The Team starter performs one navigation activation and does not send a Chat Bot message. |

The Team query owns configuration freshness. No manual refresh control is introduced.

## States

| State | Behavior |
| --- | --- |
| Loading | The page renders a content-shaped skeleton under the Team breadcrumb. |
| Empty | The route has no Team collection and no creation empty state; a missing Team renders the unavailable state. |
| No results | Inapplicable: the first release exposes one Team. |
| Error | Load failures use the shared recoverable error state; save failures remain control-local. |
| Busy | Start and Save each show control-local progress. Neither blocks the other control's separate goal. |
| Offline | Inherits `shared-states.md`; React Query reconnects the Team query and no refresh action is added. |
| Long content | Instructions and process paths use wrapping text areas; the page grid remains horizontally bounded. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:team.fallback` | State |
| `agentTeams:team.updated` | Constraint |
| `agentTeams:team.unsaved` | State |
| `agentTeams:team.save` | Action |
| `agentTeams:team.saving` | State |
| `agentTeams:team.saveFailed` | Recovery |
| `agentTeams:team.process` | State |
| `agentTeams:team.roles` | State |
| `agentTeams:run.title` | State |
| `agentTeams:run.intent` | Constraint |
| `agentTeams:run.intentPlaceholder` | Constraint |
| `agentTeams:run.projectDirectory` | Constraint |
| `agentTeams:run.projectDirectoryPlaceholder` | Constraint |
| `agentTeams:run.mode` | Constraint |
| `agentTeams:run.start` | Action |
| `agentTeams:run.starting` | State |
| `agentTeams:run.startFailed` | Recovery |
| `agentTeams:run.commands` | Constraint |
| `agentTeams:run.commandsPlaceholder` | Constraint |
| `agentTeams:run.commandsHint` | Constraint |
| `agentTeams:run.planOnly` | Action |
| `agentTeams:run.validateExisting` | Action |
| `agentTeams:run.implementAndValidate` | Action |
| `agentTeams:model.default` | Action |
| `agentTeams:model.label` | Constraint |
| `agentTeams:instructions.label` | Constraint |
| `agentTeams:entryPoints.label` | Constraint |
| `agentTeams:entryPoints.placeholder` | Constraint |
| `agentTeams:skills.label` | Constraint |
| `agentTeams:mcpServers.label` | Constraint |
| `agentTeams:tools.label` | Constraint |
| `agentTeams:role.planner` | State |
| `agentTeams:role.test_designer` | State |
| `agentTeams:role.developer` | State |
| `agentTeams:role.test_author` | State |
| `agentTeams:role.test_runner` | State |
| `agentTeams:role.reviewer` | State |
| `agentTeams:loading` | State |
| `agentTeams:loadFailed` | Recovery |
| `agentTeams:unavailable.title` | State |
| `agentTeams:unavailable.description` | Recovery |

## Accessibility

The Start and Save forms use labelled fields and submit natively with `Enter`. Role cards are headed by their role names, checkbox groups have visible group labels, and the tabular order follows the visual order: run form, metadata, then roles. Busy controls retain their text and add an animation-safe spinner. Status and failure text use `role="status"` or `role="alert"` as appropriate. Unsaved and updated states include text rather than color alone, and all controls retain the shared visible focus ring.

## Coverage Status

Pending verification

## Changelog

### 2026-10-03

- Added the direct built-in Team detail specification, including one-activation run creation, one-activation Team save, role configuration, exact command grants, and no Team creation or deletion.
