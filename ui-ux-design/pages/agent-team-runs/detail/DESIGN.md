# Agent Team Run Detail

## Route

`/agent-team-runs/:runId`

The route is a direct run destination reached from Team run creation. It is not a top-level Run collection because the first release has no Team Run list API.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/web/src/routes/agent-team-runs/$runId.tsx`
- `apps/web/src/features/agent-teams/team-run-detail.tsx`

## Purpose

Observe one Team run, answer its current input, recover uncertain effects, and continue or stop it without moving role outputs manually.

## Primary Task

Understand and continue the current run. Reading costs no action: the persisted Run query and replayable SSE stream keep state fresh. Each independent continuation goal costs one activation: answer, operation recovery, resume, retry, pause, or cancel.

## Layout

The page uses the full Workspace page width with a `1200px` maximum. The heading and execution controls are followed by immutable TeamVersion metadata, mode, intent, project directory, command grants, and scope revision. The main desktop grid places active work — pending input or recovery, then task attempts — in a wider primary column and documents, operations, and criterion assessments in a supporting column. Columns stack below `1024px`. The live member output occupies a fixed reading column with its own bounded scroll region; documents and command evidence use disclosures with bounded preformatted regions rather than expanding the page.

## Interaction Contract

| Action | Trigger and behavior |
| --- | --- |
| Observe run | The Run query is refreshed by SSE events while work is active. Persisted event replay and browser-managed `Last-Event-ID` reconnection preserve member output without a manual refresh. |
| Answer input | The Answer control shows local progress, submits the exact pending input id and scope revision, and replaces the Run cache with the server response. Failure leaves the answer and command grants available. |
| Recover uncertain operation | Selecting one structured decision and submitting it shows local progress and uses the operation key in both path and body. Failure leaves the decision selected. |
| Pause | Pause shows local progress and preserves the request as visible pending state until the server settles at a stable boundary. |
| Resume | Resume shows local progress and is available only for a paused run. If recovery remains pending, the server returns it to the recovery input. |
| Cancel | Cancel opens the shared destructive confirmation pattern, then shows local progress. Cancellation remains visible until active work settles. |
| Retry failed task | Only a server-declared retryable active task renders Retry. Its control shows local progress and sends that task key. Successful predecessors are never rerun by the UI. |
| Read command evidence | An operation with a linked Command loads its command, status, exit code, and bounded replayed output through the existing Command query and event stream. |
| Open Team | The TeamVersion link returns to the immutable Team's configuration route without changing run state. |

SSE transport failure is shown as a reconnecting state, not a run failure. The persisted Run query remains the recovery path if the stream cannot reconnect.

## States

| State | Behavior |
| --- | --- |
| Loading | The page renders a content-shaped skeleton under the Team Run breadcrumb. |
| Empty | A missing Run renders the unavailable state; it has no creation fallback. |
| No results | Inapplicable: the route addresses one Run. |
| Error | Load failures use the shared recoverable error state. Mutation failures are control-local alerts and never replace durable Run data. |
| Busy | Every action control owns its spinner and disabled state; no full-page blocking overlay is used. |
| Offline | SSE shows a reconnecting cue, React Query retries the persisted snapshot, and completed durable sections remain readable. |
| Long content | Member output, documents, task result JSON, and command output use bounded scroll or disclosure regions. Output is never silently truncated. |

The page distinguishes execution status from criterion assessment. `succeeded` is only the Run completion state; criterion values remain `met`, `unmet`, or `not_verified` with their evidence.

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:run.detail.title` | State |
| `agentTeams:run.loading` | State |
| `agentTeams:run.loadFailed` | Recovery |
| `agentTeams:run.unavailable.title` | State |
| `agentTeams:run.unavailable.description` | Recovery |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.desiredControl.*` | State |
| `agentTeams:run.version` | State |
| `agentTeams:run.modeValue.*` | State |
| `agentTeams:run.project` | State |
| `agentTeams:run.commands` | Constraint |
| `agentTeams:run.noCommands` | State |
| `agentTeams:run.scopeRevision` | State |
| `agentTeams:tasks.title` | State |
| `agentTeams:tasks.empty` | State |
| `agentTeams:tasks.attempt` | State |
| `agentTeams:tasks.result` | State |
| `agentTeams:tasks.retry` | Action |
| `agentTeams:tasks.retrying` | State |
| `agentTeams:tasks.retryFailed` | Recovery |
| `agentTeams:input.title` | State |
| `agentTeams:input.answer` | Action |
| `agentTeams:input.answering` | State |
| `agentTeams:input.answerFailed` | Recovery |
| `agentTeams:input.answerPlaceholder` | Constraint |
| `agentTeams:input.commands` | Constraint |
| `agentTeams:recovery.title` | State |
| `agentTeams:recovery.operation` | State |
| `agentTeams:recovery.adoptCommand` | Action |
| `agentTeams:recovery.markFailed` | Action |
| `agentTeams:recovery.replay` | Action |
| `agentTeams:recovery.submit` | Action |
| `agentTeams:recovery.submitting` | State |
| `agentTeams:recovery.failed` | Recovery |
| `agentTeams:output.title` | State |
| `agentTeams:output.empty` | State |
| `agentTeams:output.reconnecting` | State |
| `agentTeams:documents.title` | State |
| `agentTeams:documents.empty` | State |
| `agentTeams:documents.revision` | State |
| `agentTeams:operations.title` | State |
| `agentTeams:operations.empty` | State |
| `agentTeams:operations.command` | State |
| `agentTeams:operations.exitCode` | State |
| `agentTeams:operations.output` | State |
| `agentTeams:outcome.title` | State |
| `agentTeams:outcome.summary` | State |
| `agentTeams:outcome.unresolved` | State |
| `agentTeams:outcome.criteria` | State |
| `agentTeams:outcome.evidence` | State |
| `agentTeams:outcome.assessment.met` | State |
| `agentTeams:outcome.assessment.unmet` | State |
| `agentTeams:outcome.assessment.not_verified` | State |
| `agentTeams:controls.pause` | Action |
| `agentTeams:controls.pausing` | State |
| `agentTeams:controls.resume` | Action |
| `agentTeams:controls.resuming` | State |
| `agentTeams:controls.cancel` | Action |
| `agentTeams:controls.cancelling` | State |
| `agentTeams:controls.cancelTitle` | Constraint |
| `agentTeams:controls.cancelDescription` | Constraint |
| `agentTeams:controls.cancelConfirm` | Action |
| `agentTeams:controls.failed` | Recovery |
| `agentTeams:openTeam` | Action |

## Accessibility

The heading hierarchy moves from Run title to section titles. Controls are native buttons with visible text and shared focus rings; only the copy-id control is icon-independent and remains labelled by its value. Live output, reconnecting, queued, working, waiting, and paused states use polite status regions; failures use alerts. Every status includes a text label in addition to color. Recovery is a labelled radio group, so arrow keys move between the three decisions and the decision remains visible if submission fails. Disclosure summaries and preformatted regions are keyboard reachable, and focus is not moved after SSE updates. Cancel uses a labelled dialog and returns focus to its invoking pattern on close.

## Coverage Status

Pending verification

## Changelog

### 2026-10-03

- Added the Team Run detail specification for replayable observation, structured pending input, operation recovery, bounded evidence, independent lifecycle controls, and distinct completion versus assessment state.
