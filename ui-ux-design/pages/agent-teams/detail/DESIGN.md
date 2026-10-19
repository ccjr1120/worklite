# Agent Team Work Records

## Route

`/agent-teams/:teamId`. Work records are the only page view. One built-in Team has no Team collection or creation/deletion surface.

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
- `apps/web/src/routes/agent-teams/$teamId.index.tsx`
- `apps/web/src/features/agent-teams/team-detail.tsx`
- `apps/web/src/features/agent-teams/team-records.tsx`

## Purpose

Find Team task groups and open their live conversation.

## Primary Task

Open a work record to inspect its conversation. Action budget: one group activation. The single `New work record` action creates an empty group and opens it; work begins when the user addresses a role in the group. Chat may also start group work. The context bar's upper-right `Configuration` action opens the separate Team configuration page.

## Layout

Use the shared detail width up to 1200px. Work records are the sole body of this route, with no page tabs. The context bar places one secondary `Configuration` action at the upper right. Records are a compact list of task groups showing the title, latest message, status, repositories, Run count and update time. The toolbar has one `New work record` action. Narrow screens stack metadata without removing status or the group link. Shared semantic tokens govern both light and dark modes.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Open configuration | Navigate to `/agent-teams/:teamId/configuration` from the context-bar action in one activation. |
| Open record | Navigate to `/agent-team-groups/:groupId` in one activation. |
| New work record | Create an empty task group and navigate to `/agent-team-groups/:groupId`; no goal/directory form precedes the group. |
| Open Chat | Navigate to Chat from the empty-state link to start work there. |

The group-summary query keeps records fresh. It does not load message history, task activity or Run snapshots. The selected group route owns its messages and event stream.

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain page geometry. |
| Empty | Keep `New work record` available and show the separate Chat entry. |
| Error | Show the shared recoverable error; the separate configuration route remains available. |
| Busy | Work-record creation shows control-local progress. Existing record links remain independent. |
| Offline | Inherits shared-states.md. |
| Long content | Wrap goal and paths; stack row metadata on narrow screens. |
| Active group | Show server-derived group status and retain the group link. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:loading` | State |
| `agentTeams:loadFailed` | Recovery |
| `agentTeams:unavailable.title` | State |
| `agentTeams:unavailable.description` | Recovery |
| `agentTeams:configuration.open` | Action |
| `agentTeams:records.empty` | State |
| `agentTeams:records.startInChat` | Action |
| `agentTeams:records.title` / `description` / `create` / `creating` | State / Action |
| `agentTeams:records.createFailed` / `empty` / `loadFailed` | Recovery / State |
| `agentTeams:group.untitled` / `noMessages` / `noRepositories` / `runCount` | State |
| `agentTeams:records.loadFailed` | Recovery |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.modeValue.*` | State |
| `agentTeams:resources.providers` | State |
| `agentTeams:resources.skills` | State |
| `agentTeams:resources.mcpServers` | State |
| `agentTeams:resources.loadFailed` | Recovery |
| `agentTeams:role.*` | State |

## Accessibility

Record links and the upper-right configuration action are keyboard reachable with visible focus. Status uses icon/text alongside color. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

2026-10-19 source comparison: Records are the only view on the Team route; the upper-right context-bar action opens the separate configuration route, and task groups open their conversation route. The list shows title, latest message, status, repositories, Run count and update time; the empty state keeps both the new-record action and its separate Chat link. No differences found against the documented layout and interactions. No browser, runtime, build, test or type-check verification was performed.

## Changelog

### 2026-10-19

- Replaced Run summary records with durable group records, added one-action empty group creation, and added working-practice and Team memory configuration.
- Made work records the only view on the Team detail route and moved configuration to a separate route linked from the upper-right context bar action.

### 2026-10-13

- Replaced Team conversation, intake, historical projection and manual launch entries with linked Run records and separate role configuration. Chat Agent dispatches Team Runs; Run detail owns questions, command grants, documents and recovery.
