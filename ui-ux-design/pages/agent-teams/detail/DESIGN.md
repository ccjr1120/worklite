# Agent Team Work Records

## Route

`/agent-teams/:teamId`. Work records are the only page view. Two predefined built-in Teams have no creation/deletion surface; a Team switcher on this page shows both and selects which Team's records and configuration are shown. `/agent-teams` without a Team id replaces itself with the default Company Project Team (`agent_team_bmad_tea`); the switcher on that page makes the Application Development Team visible. The sidebar and command-menu Agent Team entries open `/agent-teams`. Chat selects the Team for dispatch and owns configuration writes for both. The read-only configuration companion lives at `/agent-teams/:teamId/config` ([Configuration](../config/DESIGN.md)).

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/web/src/routes/agent-teams/index.tsx`
- `apps/web/src/routes/agent-teams/$teamId.tsx`
- `apps/web/src/routes/agent-teams/$teamId.index.tsx`
- `apps/web/src/features/agent-teams/team-records.tsx`
- `apps/web/src/features/agent-teams/team-switcher.tsx`

## Purpose

See which Team is shown, switch between the two Teams, find Team Runs and open their read-only execution evidence. Chat owns all Team operations.

## Primary Task

Open a Run to inspect its evidence. Action budget: one Run activation, or one switcher activation to show the other Team first. Start or change Team work, answer questions, control Runs, and manage Team configuration in Chat.

## Layout

Use the shared detail width up to 1200px. The breadcrumb reads `Agent Team / <Team name>` and the page heading title is the selected Team's name. Directly below the heading, a Team switcher lists every Team from `GET /agent-teams` as a two-column card row (one column on narrow screens). Each card shows the Team name, a project-focus chip when one is defined for that Team (`面向已有公司仓库` for Company Project Team, `面向全新应用开发` for Application Development Team), its description, and a tabular metric line with the concurrency limit, active Run count (`running`, `waiting_for_input`, `paused`) and queued Run count derived from that Team's Run summaries. The selected card uses a `brand` border, `brand-subtle` tint and a `当前` label; other cards stay neutral with the ordinary `surface-subtle` hover. Run records follow the switcher as the page body, with no page tabs or mutation controls. Each compact row shows status, intent, an owning-Team chip, project directory, mode, creation time and finish time when present; it opens immutable Run evidence. The page heading and empty state both link to Chat to start work. Narrow screens wrap the path and stack metadata without removing status or the Run link. Shared semantic tokens govern both light and dark modes.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Switch Team | Activating a switcher card navigates to `/agent-teams/:teamId` for that Team in one activation; the URL is the selection state, so direct links and refreshes render the same Team. |
| Open Run | Navigate to `/agent-team-runs/:runId` in one activation. |
| View configuration | Navigate to `/agent-teams/:teamId/config` for the selected Team from the page heading; the configuration page is read-only and links back here. |
| Start Team work | Navigate to Chat from the page heading or empty-state link; Chat collects any missing dispatch information. |

The Run-summary query refreshes every five seconds per Team, and the switcher counts reuse the same per-Team queries, so the selected Team's records and its card counts come from one request. The Team list query loads once per visit. It does not load task activity or Run snapshots. Run detail owns its read-only evidence stream. Chat owns Team mutations and live pending-input handling.

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain page geometry; switcher cards show placeholder counts until their Run summaries arrive. |
| Empty | Show the Chat entry to start Team work; the switcher still shows both Teams. |
| Error | Show the shared recoverable error for the records; a Team-list failure hides only the switcher and the heading falls back to `Agent Team`. |
| Busy | List loading stays local; there are no mutation controls on this page. |
| Offline | Inherits shared-states.md. |
| Long content | Wrap goal, description and paths; stack row metadata and switcher cards on narrow screens. |
| Active Run | Show server-derived status and retain the Run link; the owning card counts it as active or queued. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:records.title` / `description` / `empty` / `loadFailed` | State / Recovery |
| `agentTeams:records.openChat` | Action |
| `agentTeams:config.viewConfig` | Action |
| `agentTeams:records.finishedAt` | State |
| `agentTeams:switcher.label` / `current` | State |
| `agentTeams:switcher.maxConcurrentRuns` / `activeRuns` / `queuedRuns` | State |
| `agentTeams:focus.*` | State |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.modeValue.*` | State |
| `agentTeams:role.*` | State |

## Accessibility

Switcher cards are links inside a labelled navigation landmark; the selected card carries `aria-current="page"` and the visible `当前` text, so selection does not depend on color. Run links are keyboard reachable with visible focus. Status uses icon/text alongside color. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

Verified 2026-10-21 against `apps/web/src/features/agent-teams/team-records.tsx`, `team-switcher.tsx` and `apps/web/src/routes/agent-teams/`. Differences found: none. The switcher lists both Teams with focus chip, description, concurrency limit and active/queued counts; the selected Team is highlighted with `aria-current`; `/agent-teams` replaces itself with the default Team; each Run row shows its owning Team. Component tests cover the switcher, records page and index redirect; no browser verification was run.

2026-10-20 source comparison: the route renders compact Run summaries, a Chat link, and a bordered `查看配置` link to the read-only configuration page. No create, configuration-edit, answer or Run-control action remains on the Team page. This was a source review; no runtime or browser verification was run.

2026-10-20 earlier comparison: the route renders only compact Run summaries and a Chat link; each summary opens read-only Run evidence. No create, configuration, answer or Run-control action remains on the Team page. The summary response exposes no progress percentage, so the list shows status and timestamps only. This was a source review; no runtime or browser verification was run.

## Changelog

### 2026-10-21 - Visible Team switching

- Added a Team switcher listing both predefined Teams with project focus, description, concurrency limit and active/queued Run counts; the selected Team is highlighted and drives the URL.
- The heading and breadcrumb name the selected Team, Run rows show their owning Team, `/agent-teams` replaces itself with the default Team, and the workspace entries open `/agent-teams` instead of a hard-coded Team.
- `查看配置` opens the selected Team's `/agent-teams/:teamId/config` instead of the fixed Company Project Team page.


### 2026-10-20 - Two predefined Teams

- Clarified that Chat selects and configures either Team while the existing workspace link and fixed configuration page remain scoped to Company Project Team.

### 2026-10-20 - Read-only configuration entry

- Added the `查看配置` page-heading link to the new read-only configuration page at `/agent-team-config`.

### 2026-10-20

- Changed the Team route from group records and creation/configuration actions to a read-only Run list with a Chat entry for Team operations.

### 2026-10-19

- Replaced Run summary records with durable group records, added one-action empty group creation, and added working-practice and Team memory configuration.
- Made work records the only view on the Team detail route and moved configuration to a separate route linked from the upper-right context bar action.

### 2026-10-13

- Replaced Team conversation, intake, historical projection and manual launch entries with linked Run records and separate role configuration. Chat Agent dispatches Team Runs; Run detail owns questions, command grants, documents and recovery.
