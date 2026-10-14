# Agent Team Detail

## Route

`/agent-teams/:teamId?tab=records|configuration`. Records is the default. One built-in Team has no collection or creation/deletion surface.

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
- `apps/web/src/features/agent-teams/team-records.tsx`

## Purpose

Find Team work and open its Run progress; configure the Team separately.

## Primary Task

Open a work record to inspect its progress. Action budget: one record activation. Only Chat Agent starts Team work; the page has no composer or manual launch action. Saving edited configuration is a separate goal with one Save action.

## Layout

Use the shared detail width up to 1200px and Records/Configuration tabs persisted in route search. Records is a compact list of linked rows showing goal, status, directory, execution mode, start time and end time. Queued Runs appear with their queued status and each row opens Run detail. Configuration includes `maxConcurrentRuns` (default 3, minimum 1) in the single Save flow. Narrow screens stack metadata without removing status or the Run link. Configuration retains the six-role list, provider-grouped model selectors and advanced disclosures, plus one Save action in the context bar. The Developer executor selector remains. Shared semantic tokens govern both light and dark modes.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Select tab | Update validated route search without mutating configuration or Runs. |
| Open record | Navigate to `/agent-team-runs/:runId` in one activation. |
| Save configuration | Report progress on Save; replace cached Team on success and retain edits/error on failure. |
| Expand role | Disclose instructions, entry points, Skills, MCP servers and tools without saving. |
| Edit concurrent Run limit | Update `maxConcurrentRuns` locally; the single Save action commits the value and shows local progress. |

The summary-record query keeps records fresh. It reads no task activity, event history or TeamVersion snapshot. No Team conversation query, stream, queue or historical projection remains.

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain page geometry. |
| Empty | State that no work records exist and point to Chat for starting work. |
| Error | Shared recoverable load error; preserve unaffected configuration. |
| Busy | Configuration Save shows control-local progress. Record links remain independent. |
| Offline | Inherits shared-states.md. |
| Long content | Wrap goal and paths; stack row metadata on narrow screens. |
| Queued record | Show the queued status and retain the Run detail link while waiting for a parallel slot. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:loading` | State |
| `agentTeams:loadFailed` | Recovery |
| `agentTeams:unavailable.title` | State |
| `agentTeams:unavailable.description` | Recovery |
| `agentTeams:configuration.tab` | Action |
| `agentTeams:records.tab` | Action |
| `agentTeams:records.empty` | State |
| `agentTeams:records.startInChat` | Action |
| `agentTeams:records.startedAt` | State |
| `agentTeams:records.finishedAt` | State |
| `agentTeams:records.loadFailed` | Recovery |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.modeValue.*` | State |
| `agentTeams:resources.providers` | State |
| `agentTeams:resources.skills` | State |
| `agentTeams:resources.mcpServers` | State |
| `agentTeams:resources.loadFailed` | Recovery |
| `agentTeams:team.updated` | State |
| `agentTeams:team.save` | Action |
| `agentTeams:team.saving` | State |
| `agentTeams:team.saveFailed` | Recovery |
| `agentTeams:team.process` | State |
| `agentTeams:team.processId` | State |
| `agentTeams:team.processVersion` | State |
| `agentTeams:team.maxConcurrentRuns.label` | Constraint |
| `agentTeams:team.maxConcurrentRuns.hint` | Constraint |
| `agentTeams:team.roles` | State |
| `agentTeams:team.parallelism` | State |
| `agentTeams:team.advanced` | Action |
| `agentTeams:model.default` | Action |
| `agentTeams:model.label` | Constraint |
| `agentTeams:team.executor.label` | Constraint |
| `agentTeams:team.executor.claude` | State |
| `agentTeams:team.executor.codex` | State |
| `agentTeams:instructions.label` | Constraint |
| `agentTeams:entryPoints.label` | Constraint |
| `agentTeams:entryPoints.placeholder` | Recovery |
| `agentTeams:skills.label` | Constraint |
| `agentTeams:skills.empty` | State |
| `agentTeams:mcpServers.label` | Constraint |
| `agentTeams:mcpServers.empty` | State |
| `agentTeams:tools.label` | Constraint |
| `agentTeams:role.*` | State |

## Accessibility

Record links are keyboard reachable with visible focus. Status uses icon/text alongside color. Tab selection and configuration controls keep their existing accessible labels. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

2026-10-14 source comparison: the Team route defaults to Records and retains Configuration; the records query shows server Run summaries, including queued Runs, and opens Run detail. Configuration saves `maxConcurrentRuns` (default 3, minimum 1) through the single Save action. Chat is the only Run entry; there is no manual Run creation or Team conversation surface. Orchestration v4 worktree evidence remains on Run detail. Source review only; no browser, runtime, build, or test verification was performed.

## Changelog

### 2026-10-13

- Replaced Team conversation, intake, historical projection and manual launch entries with linked Run records and separate role configuration. Chat Agent dispatches Team Runs; Run detail owns questions, command grants, documents and recovery.
