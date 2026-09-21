# Workflow Node Log Presentation

## Route

`Not a standalone route; embedded in the Workflow List Run records dialog and in the Run detail route at /runs/:runId.`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/features/workflows/run-history-dialog.tsx`
- `apps/web/src/features/workflows/node-run-log.tsx`
- `apps/web/src/routes/runs.$runId.tsx`

## Purpose

Read what one Workflow node received, what it produced, and what it did internally while producing it.

## Primary Task

Find why a node produced the output it did. Action budget: one — expand the node entry, which reveals its mapped input, committed output, and activity timeline together.

The three are one investigation rather than three, so they open together. Expanding does not fetch: the Run detail query already carries them.

## Layout

The node entry keeps its existing collapsed row: status, type, position, node identifier, timing, and retry count. Expansion adds stacked labelled regions in fixed order — Input, Activity, Output — so the reading order matches execution order.

Inside the Run records dialog the entry is bounded by the dialog's own scrolling surface. At `/runs/:runId` it uses available width, following the `page-patterns.md` rule that logs use available width, and the activity timeline gains room rather than a different structure. Payload regions are height-bounded scroll containers in both hosts.

## Interaction Contract

### Expand a node entry

Activating the entry's disclosure reveals Input, Activity, and Output. The expanded state is local to the host surface and is not persisted in route state, because it identifies a reading position rather than an investigation others would share.

### Read a payload

Mapped input and committed output render as plain preformatted text inside a height-bounded scroll container. Each offers `Copy`, which reports `Copied` on the control activated. A payload is recorded execution data, not product content: it renders without markup interpretation and without fetching anything it names. Generated image payloads arrive already reduced to their credential-safe summary by the server, so no image bytes reach this surface.

### Read the activity timeline

Activity entries are ordered by their event sequence and labelled by phase: node setup, each attempt, model rounds, Skill script calls, MCP tool calls, and the outgoing edge decision. Each entry states its phase and the few values that make it legible — the model and finish reason for a round, the script path and exit code for a Skill call, the tool and status for an MCP call, the evaluated condition and traversal count per edge.

A Skill script entry does not inline script output. It names the command execution that owns that output, because `command_execution_events` is its single owner.

An Agent node's streamed model text is one region rather than one entry per token, appended as `node.delta` events arrive.

### Stay current during an active Run

Node entries are self-healing through the Run event stream the host surface already subscribes to. Activity, streamed text, and status arrive without being asked and without a manual refresh control, because staleness is server-observable.

Incoming events apply incrementally to cached Run detail. An event must not trigger a full Run refetch: activity multiplies the event count for one Run, so refetching per event would make an active Run's own timeline the reason it stalls.

### Open the correlated Provider request

An Agent or image node entry links to the Logs `requests` tab filtered to this Run, where the captured upstream request and response for its model rounds are readable. The link states that captured requests are kept for three days, because a Run outliving that window keeps its activity while those bodies are already expired.

## States

| State | Behavior |
| --- | --- |
| Loading | Inherits `shared-states.md`. The collapsed entry renders from Run detail; no entry frame is drawn above absent content. |
| Empty | A node that recorded no activity shows its input and output without an Activity region rather than an empty one. A node whose payload is genuinely absent shows an em-dash. |
| No results | Not applicable; this surface has no filters. |
| Error | A failed node keeps its existing credential-safe failure reason above the payload regions, and retry remains the node-local control defined in `shared-states.md`. A rejected retry appears beside that reason rather than replacing it. |
| Busy | Retry reports on its own control. Expansion is immediate and reports nothing, because it fetches nothing. |
| Offline | Inherits `shared-states.md`. The reconnecting bar owns transport state; entries retain the activity already received. |
| Long content | Payloads and streamed text stay inside height-bounded scroll containers with `Copy`. A long activity timeline scrolls within its host rather than extending it. Streaming text preserves scroll position unless the reader is following the end. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `runs:nodeLog.input` / `output` / `activity` / `streamedOutput` | State |
| `runs:nodeLog.expand` / `collapse` | Action |
| `runs:nodeLog.copy` / `copied` | Action |
| `runs:nodeLog.noActivity` | State |
| `runs:nodeLog.phase.setup` / `attempt` / `modelRound` / `skillScript` / `mcpCall` / `edgeDecision` | State |
| `runs:nodeLog.attempt` / `automaticRetry` | State |
| `runs:nodeLog.modelRound` / `finishReason` / `contextDropped` | State |
| `runs:nodeLog.skillScript` / `exitCode` / `commandExecution` | State |
| `runs:nodeLog.mcpCall` | State |
| `runs:nodeLog.edgeTraversed` / `edgeSkipped` / `edgeTerminal` / `edgeTraversals` | State |
| `runs:nodeLog.viewRequestLogs` | Action |
| `runs:nodeLog.requestLogRetention` | Constraint |

Node identifiers, model ids, script paths, tool names, evaluated conditions, and payload contents are server-owned execution values rather than product copy and carry no keys.

## Accessibility

The entry disclosure is a button whose accessible name names the node and its position, with its expanded state exposed. Payload and activity regions are labelled by their headings and are keyboard-scrollable, so a bounded container is reachable without a pointer. Each `Copy` control names what it copies. Activity phase and status are text, never color alone; the streaming cue pairs its indicator with text and does not announce every token to assistive technology.

## Coverage Status

Verified 2026-09-21. Differences found against the implementation:

- The Run records dialog previously discarded `node.delta` events and invalidated the whole Run detail on every other event. This change applies events incrementally, so streamed text is now displayed rather than dropped.
- Expansion state is local to each host and is not restored by a shared link, unlike the `request-logs` filters, which are.
- Captured payloads render as preformatted text only. No JSON tree, syntax highlighting, or payload diffing is provided in this increment.

## Changelog

### 2026-09-21 - Logs destination

- Repointed the Run-scoped request-log link from the Providers `request-logs` view to the Logs `requests` tab. The retention constraint beside it is unchanged.

### 2026-09-21

- Established this surface: node mapped input, committed output, streamed model text, and the ordered activity timeline disclosed together from one expansion in both the Run records dialog and the Run detail route.
- Required incremental application of Run events instead of per-event Run refetching, and recorded that streamed node text was previously persisted but never displayed.
- Required Skill script activity to name its command execution rather than inline script output, keeping `command_execution_events` the single owner.
- Required payloads to render as untrusted preformatted text in height-bounded scroll containers, and recorded that generated image payloads arrive pre-reduced to their summary.
- Added the correlated Provider request-log link with its three-day retention constraint.
