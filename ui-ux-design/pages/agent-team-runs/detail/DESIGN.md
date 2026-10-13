# Agent Team Run Detail

## Route

`/agent-team-runs/:runId`

The route is a direct immutable-evidence destination reached from its originating Team conversation or a retained Run link. It is not a top-level Run collection because the first release has no Team Run list API.

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

Understand and continue the current run. Reading costs no action: the persisted Run query and replayable SSE stream keep state fresh. Codex developer tasks execute directly with no WorkLite proposal or command-grant step. Their clarification panel has only the answer input; non-Codex roles retain exact-command fields. Each independent continuation goal costs one activation: answer, operation recovery, resume, retry, pause, or cancel.

## Layout

The page uses the full Workspace page width with a `1200px` maximum. The heading and execution controls are followed by a progress header naming the current phase, a thin progress bar with the server-derived completion percentage (terminal-only 100), next step, completed and total development assignments, active Developers, and the waiting reason, then immutable TeamVersion metadata, mode, intent, project directory, command grants, and scope revision. The main desktop grid places active work — pending input or recovery, then task attempts — in a wider primary column and documents, operations, and criterion assessments in a supporting column. Development task attempts carry their Developer and assignment title beside the task key and show the attempt's latest public progress text while it runs; test authoring, test execution, and review attempts remain single tasks after the fan-in. Pending input panels name their owning task attempt. The live member output occupies a fixed reading column with its own bounded scroll region and a lane filter that scopes it to one Developer lane; deltas are grouped per task attempt into foldable sections — the active attempt stays expanded, settled attempts fold — with text rendered as Markdown and tool or command activity collapsed to compact rows, instead of one raw preformatted stream. Columns stack below `1024px`. Documents and command evidence use disclosures with bounded preformatted regions rather than expanding the page.

## Interaction Contract

| Action | Trigger and behavior |
| --- | --- |
| Observe run | The Run query is refreshed by SSE events while work is active. Persisted event replay and browser-managed `Last-Event-ID` reconnection preserve member output without a manual refresh. |
| Filter member output by lane | One selection scopes the live output column to all lanes or one Developer lane; the persisted stream is unchanged and the filter resets when the run changes. |
| Answer input | The Answer control shows local progress, submits the exact pending input id and scope revision, and replaces the Run cache with the server response. Failure preserves the answer and any non-Codex command-grant input. Codex developer questions omit the command-grant field. |
| Recover uncertain operation | Selecting one structured decision and submitting it shows local progress and uses the operation key in both path and body. Failure leaves the decision selected. |
| Pause | Pause shows local progress and preserves the request as visible pending state until the server settles at a stable boundary. |
| Resume | Resume shows local progress and is available only for a paused run. If recovery remains pending, the server returns it to the recovery input. |
| Cancel | Cancel opens the shared destructive confirmation pattern, then shows local progress. Cancellation remains visible until active work settles. |
| Retry failed task | Only a server-declared retryable active task renders Retry. Its control shows local progress and sends that task key. Successful predecessors are never rerun by the UI. |
| Read command evidence | An operation with a linked Command loads its command, status, exit code, and bounded replayed output through the existing Command query and event stream. |
| Open Team | The TeamVersion link returns to the originating Team conversation when that link is available, otherwise the direct Team route, without changing run state. |

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
| Long content | Member output, documents, changed-file lists, task result JSON, and command output use bounded scroll or disclosure regions. Output is never silently truncated. |
| Parallel development | The progress header reports phase, a progress bar with the completion percentage, assignment completion, active Developers, and next step; development attempts show their lane attribution and latest public progress text, and live output groups deltas per task attempt with the active attempt expanded. |

The page distinguishes execution status from criterion assessment. `succeeded` is only the Run completion state; criterion values remain `met`, `unmet`, or `not_verified` with their evidence.

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:run.detail.title` | State |
| `agentTeams:run.loading` | State |
| `agentTeams:run.loadFailed` | Recovery |
| `agentTeams:run.unavailable.title` | State |
| `agentTeams:run.unavailable.description` | Recovery |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.desiredControl.*` | State |
| `agentTeams:metadata.title` | State |
| `agentTeams:metadata.status` | State |
| `agentTeams:metadata.taskKey` | State |
| `agentTeams:run.version` | State |
| `agentTeams:run.mode` | Constraint |
| `agentTeams:run.modeValue.*` | State |
| `agentTeams:run.intent` | Constraint |
| `agentTeams:run.project` | State |
| `agentTeams:run.commands` | Constraint |
| `agentTeams:run.noCommands` | State |
| `agentTeams:run.scopeRevision` | State |
| `agentTeams:tasks.title` | State |
| `agentTeams:tasks.empty` | State |
| `agentTeams:tasks.attempt` | State |
| `agentTeams:tasks.changedFiles` | State |
| `agentTeams:tasks.noChangedFiles` | State |
| `agentTeams:tasks.assignedWork` | State |
| `agentTeams:tasks.assignedWorkCompleted` | State |
| `agentTeams:tasks.assignedWorkNotCompleted` | State |
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
| `agentTeams:recovery.decision` | Constraint |
| `agentTeams:recovery.adopt_command` | Action |
| `agentTeams:recovery.mark_failed` | Action |
| `agentTeams:recovery.replay` | Action |
| `agentTeams:recovery.submit` | Action |
| `agentTeams:recovery.submitting` | State |
| `agentTeams:recovery.failed` | Recovery |
| `agentTeams:output.title` | State |
| `agentTeams:output.empty` | State |
| `agentTeams:output.reconnecting` | State |
| `agentTeams:output.lane.label` | Constraint |
| `agentTeams:output.lane.all` | State |
| `agentTeams:progress.title` | State |
| `agentTeams:progress.percent` | State |
| `agentTeams:progress.phase` | State |
| `agentTeams:progress.phase.*` | State |
| `agentTeams:progress.nextStep` | State |
| `agentTeams:progress.nextStep.*` | State |
| `agentTeams:progress.assignments` | State |
| `agentTeams:progress.activeDevelopers` | State |
| `agentTeams:progress.waitingReason.*` | State |
| `agentTeams:documents.title` | State |
| `agentTeams:documents.empty` | State |
| `agentTeams:documents.revision` | State |
| `agentTeams:documents.key` | State |
| `agentTeams:documents.upstreamKeys` | State |
| `agentTeams:documents.noUpstreamKeys` | State |
| `agentTeams:documents.content` | State |
| `agentTeams:operations.title` | State |
| `agentTeams:operations.empty` | State |
| `agentTeams:operations.command` | State |
| `agentTeams:operations.noCommand` | State |
| `agentTeams:operations.exitCode` | State |
| `agentTeams:operations.output` | State |
| `agentTeams:operations.loadFailed` | Recovery |
| `agentTeams:outcome.title` | State |
| `agentTeams:outcome.empty` | State |
| `agentTeams:outcome.summary` | State |
| `agentTeams:outcome.unresolved` | State |
| `agentTeams:outcome.noUnresolved` | State |
| `agentTeams:outcome.criteria` | State |
| `agentTeams:outcome.evidence` | State |
| `agentTeams:outcome.noEvidence` | State |
| `agentTeams:outcome.assessment.met` | State |
| `agentTeams:outcome.assessment.unmet` | State |
| `agentTeams:outcome.assessment.not_verified` | State |
| `agentTeams:role.planner` | State |
| `agentTeams:role.test_designer` | State |
| `agentTeams:role.developer` | State |
| `agentTeams:role.test_author` | State |
| `agentTeams:role.test_runner` | State |
| `agentTeams:role.reviewer` | State |
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
| `agentTeams:openConversation` | Action |
| `common:actions.cancel` | Action |

## Accessibility

The heading hierarchy moves from Run title to section titles. Controls are native buttons with visible text and shared focus rings; only the copy-id control is icon-independent and remains labelled by its value. Live output, reconnecting, queued, working, waiting, and paused states use polite status regions; failures use alerts. Every status includes a text label in addition to color. Recovery is a labelled radio group, so arrow keys move between the three decisions and the decision remains visible if submission fails. Changed-file lists use list semantics and the assigned-work summary uses a description list, so assistive technology announces the evidence relationships. Disclosure summaries and preformatted regions are keyboard reachable, and focus is not moved after SSE updates. Cancel uses a labelled dialog and returns focus to its invoking pattern on close.

## Coverage Status

2026-10-10 source comparison for progress visualization: the progress header adds a thin progress bar with the server-derived completion percentage, and live member output groups deltas per task attempt into foldable Markdown sections (active attempt expanded, tool/command activity as compact rows) while retaining the lane filter. No browser, runtime, accessibility-tool, type check or real-Run verification was authorized or performed.

2026-10-10 source comparison: the progress header follows the heading and controls and names phase, next step, assignment completion, active Developers and waiting reason; development attempts show Developer, assignment title and latest progressText; pending input panels attribute their owning attempt; a lane filter scopes live member output when more than one lane exists. Web type check (tsc --noEmit and locale key check) passed; no browser, runtime, accessibility-tool or real-Run verification was authorized or performed.

2026-10-08 authorized deployment: Gateway and Web builds, API compilation, isolated startup on ports 23490–23492 and deployment readiness on ports 23390–23392 passed through pnpm deploy:local. The deployment platform snapshot reports shared direct Chat/Team Codex execution without WorkLite grants and Chat cancellation in running/waiting states. The original conversation remains cancelled with no pending question. Browser appearance, real Codex task execution, live cancellation interaction and Feishu client behavior were not tested; no test suite or standalone type check was run.

2026-10-08 source comparison: pending-input panels identify the owning task attempt and omit command-grant fields for the Codex developer, retaining ordinary answers and recovery. No runtime, browser, type check, build or test verification was authorized or performed.

Source-level audit: 2026-10-03. The source selects the Conversation tab and `openConversation` label when `run.originatingConversationId` is present; direct-origin Runs return to the Configuration tab with `openTeam`. No other difference was found in the source-level comparison of route, observation, mutation, replay, evidence, copy, token, responsive, and accessibility structure. Only source review occurred; no browser, accessibility-tool, runtime, acceptance, or real-Run verification was performed.

## Changelog

### 2026-10-10 - Progress percentage and readable streaming output

- Added a thin progress bar with the server-derived completion percentage to the progress header, and regrouped live member output per task attempt into foldable sections with Markdown text and compact tool/command rows.

### 2026-10-10 - Parallel Developer progress

- Added the progress header (phase, next step, assignment completion, active Developers, waiting reason), Developer lane attribution and latest progress text on task attempts, owning-attempt attribution on pending inputs, and a lane filter for live member output.

### 2026-10-08 - Direct Codex execution

- Removed developer command-grant inputs while retaining non-Codex role controls and immutable Run evidence.

### 2026-10-03 - Conversation origin

- Defined the Run route as immutable execution evidence with a return link to the originating Team conversation when that link exists.

### 2026-10-03 - Structured task evidence

- Added changed-file and assigned-work completion evidence to completed task attempts while retaining raw result JSON as a secondary disclosure.

### 2026-10-03

- Added the Team Run detail specification for replayable observation, structured pending input, operation recovery, bounded evidence, independent lifecycle controls, and distinct completion versus assessment state.
- Recorded implementation metadata, evidence, empty-state, and recovery copy, and recorded the source-level coverage audit.
