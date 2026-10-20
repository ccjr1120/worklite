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
- `apps/web/src/features/agent-teams/team-records.tsx`

## Purpose

Find Team Runs and open their read-only execution evidence. Chat owns all Team operations.

## Primary Task

Open a Run to inspect its evidence. Action budget: one Run activation. Start or change Team work, answer questions, control Runs, and manage Team configuration in Chat.

## Layout

Use the shared detail width up to 1200px. Run records are the sole body of this route, with no page tabs or mutation controls. Each compact row shows intent, status, project directory, mode, creation time and finish time when present; it opens immutable Run evidence. The page heading and empty state both link to Chat to start work. Narrow screens wrap the path and stack metadata without removing status or the Run link. Shared semantic tokens govern both light and dark modes.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Open Run | Navigate to `/agent-team-runs/:runId` in one activation. |
| Start Team work | Navigate to Chat from the empty-state link; Chat collects any missing dispatch information. |

The Run-summary query refreshes every five seconds. It does not load task activity or Run snapshots. Run detail owns its read-only evidence stream. Chat owns Team mutations and live pending-input handling.

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain page geometry. |
| Empty | Show the Chat entry to start Team work. |
| Error | Show the shared recoverable error. |
| Busy | List loading stays local; there are no mutation controls on this page. |
| Offline | Inherits shared-states.md. |
| Long content | Wrap goal and paths; stack row metadata on narrow screens. |
| Active Run | Show server-derived status and retain the Run link. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:records.title` / `description` / `empty` / `loadFailed` | State / Recovery |
| `agentTeams:records.openChat` | Action |
| `agentTeams:records.finishedAt` | State |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.modeValue.*` | State |
| `agentTeams:role.*` | State |

## Accessibility

Run links are keyboard reachable with visible focus. Status uses icon/text alongside color. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

2026-10-20 source comparison: the route renders only compact Run summaries and a Chat link; each summary opens read-only Run evidence. No create, configuration, answer or Run-control action remains on the Team page. The summary response exposes no progress percentage, so the list shows status and timestamps only. This was a source review; no runtime or browser verification was run.

## Changelog

### 2026-10-20

- Changed the Team route from group records and creation/configuration actions to a read-only Run list with a Chat entry for Team operations.

### 2026-10-19

- Replaced Run summary records with durable group records, added one-action empty group creation, and added working-practice and Team memory configuration.
- Made work records the only view on the Team detail route and moved configuration to a separate route linked from the upper-right context bar action.

### 2026-10-13

- Replaced Team conversation, intake, historical projection and manual launch entries with linked Run records and separate role configuration. Chat Agent dispatches Team Runs; Run detail owns questions, command grants, documents and recovery.
