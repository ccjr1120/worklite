# Agent Team Run Detail

## Route

`/agent-team-runs/:runId`

The route is a direct immutable-evidence destination reached from a Team summary row, Chat task card or archived group link. It is not a full Run collection; the Team page reads only compact summary rows.

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

Read one Team Run's immutable execution evidence. Chat owns answers, exact Command grants, controls, and recovery.

## Primary Task

Understand the current Run. Reading costs no action: the persisted Run query and replayable SSE stream keep state fresh. Open Chat and return to the task card to answer pending input, enter structured exact Command grants, control the Run, or recover an uncertain operation.

## Layout

The page uses the shared detail width up to `1200px`. The heading links back to Chat. Its read-only progress section shows phase, server-derived percentage, next step, assignment completion, active Developer ids and waiting reason. Run metadata includes TeamVersion and orchestration version, mode, intent, project directory, scope revision, worktree paths, captured command grants and project-executor launches when present. Task attempts show status, role, assignment title, progress text, errors, results and timestamps. Pending questions state that Chat owns the answer. Documents show full content and delivery status. Operations show linked Command status, exit code, working directory, exact command and persisted output events. A separate bounded list renders persisted Run activity payloads. The outcome section shows summary, unresolved issues and criterion assessments with evidence. All sections are read-only; Chat task cards own answers, exact Command grants, controls and recovery. Agent-authored text uses the shared safe Markdown renderer; result JSON, activity payloads and command output stay preformatted.

## Interaction Contract

| Action | Trigger and behavior |
| --- | --- |
| Observe run | The Run query is refreshed by SSE events while work is active. Persisted event replay and browser-managed `Last-Event-ID` reconnection preserve member output without a manual refresh. |
| Return to Chat | Open Chat and locate the task card to answer pending input, grant exact commands through its structured field, or operate the Run through Chat. |
| Read command evidence | An operation with a linked Command loads its command, status, exit code, and persisted output events through the Command query and event stream. |
| Read Run activity | Expand the persisted activity list; each row shows the event sequence, type, timestamp and payload. |

SSE transport failure is shown as a reconnecting state, not a run failure. The persisted Run query remains the recovery path if the stream cannot reconnect.

## States

| State | Behavior |
| --- | --- |
| Loading | The page renders a content-shaped skeleton under the Team Run breadcrumb. |
| Empty | A missing Run renders the unavailable state; it has no creation fallback. |
| No results | Inapplicable: the route addresses one Run. |
| Error | Load failures use the shared recoverable error state. |
| Busy | SSE and evidence reads remain local; this page has no mutation controls. |
| Offline | The persisted Run and Command queries show their shared load recovery state when a fresh read fails. |
| Long content | Activity payloads, task result JSON and command output use bounded scroll regions. Document Markdown remains readable in the page. |
| Parallel development | The progress section reports assignment completion and active Developer ids; task attempts preserve role and assignment titles. |

The page distinguishes execution status from criterion assessment. `succeeded` is only the Run completion state; criterion values remain `met`, `unmet`, or `not_verified` with their evidence.

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` / `run.detail.title` | State |
| `agentTeams:run.loadFailed` | Recovery |
| `agentTeams:run.continueInChat` / `run.openArchive` | Action |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.version` / `versionUnknown` / `executors` | State |
| `agentTeams:run.mode` / `modeValue.*` / `intent` / `project` / `scopeRevision` | State |
| `agentTeams:run.worktreeBasePath` / `runBranch` / `commands` / `noCommands` | State |
| `agentTeams:input.title` / `run.inputInChat` | State |
| `agentTeams:metadata.title` / `taskKey` | State |
| `agentTeams:tasks.title` / `empty` | State |
| `agentTeams:progress.title` / `phase` / `phaseValue.*` / `nextStep` / `nextStepValue.*` / `assignments` / `percent` / `activeDevelopers` / `waitingReason.*` | State |
| `agentTeams:documents.title` / `empty` | State |
| `agentTeams:operations.title` / `empty` / `command` / `exitCode` / `output` / `loadFailed` / `noCommand` | State / Recovery |
| `agentTeams:outcome.title` / `summary` / `unresolved` / `noUnresolved` / `criteria` / `assessment.*` / `empty` / `noEvidence` | State |
| `agentTeams:events.title` / `empty` | State |
| `agentTeams:role.*` | State |

## Accessibility

The heading hierarchy moves from Run title to section titles. Read-only preformatted regions are keyboard reachable. Queued, working, waiting, and paused states use polite status regions; failures use alerts. Every status includes a text label in addition to color. The Chat link and archived group link are keyboard reachable. Focus is not moved after SSE updates.

## Coverage Status

2026-10-20 source comparison: all Run detail actions have moved to the Chat task card. The route displays read-only metadata, progress, task results, questions, documents, operations and activity; linked Command output still streams from persisted Command events. Compared with the previous UI, the lane filter and delta-grouped member output are no longer present; progress text and stored activity remain available. Chat renders question answers, exact command fields, controls, retry and operation recovery. This was a source review only; no runtime or browser verification was run.

2026-10-13 source comparison for orchestration v4 worktree evidence: the metadata section renders the Run-level base worktree path and run branch when the server records them, and Worktree Manager setup/teardown attempts render through the shared role label and task result disclosure. The `worktreeBasePath`/`runBranch` fields and the `worktree-manager` role are declared against the pinned cross-package contract and take effect when the packages and API lanes merge. Web type check (tsc --noEmit and locale key check) passed; no browser, runtime, accessibility-tool or real-Run verification was authorized or performed.

2026-10-13 Markdown for agent-authored text: source inspection found task progress text, pending input and recovery questions, the outcome summary and document bodies rendered as plain preformatted text. They now use the shared `StreamingMarkdown` renderer (HTML skipped) with existing semantic tokens in both themes; result JSON and command output remain preformatted. Web type check and lint were run as requested; no browser verification.

2026-10-10 source comparison for progress visualization: the progress header adds a thin progress bar with the server-derived completion percentage, and live member output groups deltas per task attempt into foldable Markdown sections (active attempt expanded, tool/command activity as compact rows) while retaining the lane filter. No browser, runtime, accessibility-tool, type check or real-Run verification was authorized or performed.

2026-10-10 source comparison: the progress header follows the heading and controls and names phase, next step, assignment completion, active Developers and waiting reason; development attempts show Developer, assignment title and latest progressText; pending input panels attribute their owning attempt; a lane filter scopes live member output when more than one lane exists. Web type check (tsc --noEmit and locale key check) passed; no browser, runtime, accessibility-tool or real-Run verification was authorized or performed.

2026-10-08 authorized deployment: Gateway and Web builds, API compilation, isolated startup on ports 23490–23492 and deployment readiness on ports 23390–23392 passed through pnpm deploy:local. The deployment platform snapshot reports shared direct Chat/Team Codex execution without WorkLite grants and Chat cancellation in running/waiting states. The original conversation remains cancelled with no pending question. Browser appearance, real Codex task execution, live cancellation interaction and Feishu client behavior were not tested; no test suite or standalone type check was run.

2026-10-08 source comparison: pending-input panels identify the owning task attempt and omit command-grant fields for the Codex developer, retaining ordinary answers and recovery. No runtime, browser, type check, build or test verification was authorized or performed.

2026-10-13 source comparison: every Run returns to Team work records; Run task links resolve directly from the bound `runId`. Pending questions, controls, document delivery and progress remain Run-owned. Source review only; no browser, runtime, build or test verification was performed.

## Changelog

### 2026-10-13 - Worktree Manager evidence

- Orchestration v4 Runs show the Worktree Manager setup and teardown as labelled task attempts, and the metadata section records the Run-level base worktree path and run branch as immutable evidence.

### 2026-10-13 - Markdown for agent-authored text

- Rendered task progress text, pending input and recovery questions, the outcome summary and document bodies through the shared safe Markdown renderer.

### 2026-10-13

- Team task references now bind directly to Run ids. Team has no conversation or intake; Chat Agent collects parameters and dispatches Runs. Run detail owns questions, command grants, documents and recovery, and returns to work records. No manual Team launch entry remains.

### 2026-10-10 - Progress percentage and readable streaming output

- Added a thin progress bar with the server-derived completion percentage to the progress header, and regrouped live member output per task attempt into foldable sections with Markdown text and compact tool/command rows.

### 2026-10-10 - Parallel Developer progress

- Added the progress header (phase, next step, assignment completion, active Developers, waiting reason), Developer lane attribution and latest progress text on task attempts, owning-attempt attribution on pending inputs, and a lane filter for live member output.

### 2026-10-08 - Direct Codex execution

- Removed developer command-grant inputs while retaining non-Codex role controls and immutable Run evidence.

### 2026-10-03 - Conversation origin

- Defined the Run route as immutable execution evidence with a return link to the Team work records when that link exists.

### 2026-10-03 - Structured task evidence

- Added changed-file and assigned-work completion evidence to completed task attempts while retaining raw result JSON as a secondary disclosure.

### 2026-10-03

- Added the Team Run detail specification for replayable observation, structured pending input, operation recovery, bounded evidence, independent lifecycle controls, and distinct completion versus assessment state.
- Recorded implementation metadata, evidence, empty-state, and recovery copy, and recorded the source-level coverage audit.
