# Run Detail

## Route

`/runs/:runId`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/runs.$runId.tsx`
- `apps/web/src/features/workflows/node-run-log.tsx`

## Purpose

Read one Workflow Run's execution in full when the Run records dialog is too small for the investigation.

## Primary Task

Follow a Run's execution node by node to the point where it went wrong, suspend an active Run, resume a paused Run, or stop an active Run. Action budget: one activation point per goal — expand the node entry in question, pause the active Run, resume the paused Run, or cancel the active Run. These lifecycle commands are independent intents and only one is available for the current status.

## Layout

Available width, following the `page-patterns.md` rule that logs use available width. This is the one Run surface not bounded by a dialog, which is its reason to exist.

A durable Run summary leads: Workflow name, immutable version, status, initiator, start time, and duration. Ordered node entries follow. Run input and result, the pending action when one exists, and Artifacts follow the nodes. Artifact presentation is owned by `surfaces/workflow-run/artifacts/DESIGN.md` and keeps its version-eligibility rule here, so a version that cannot produce Artifacts renders no section.

## Interaction Contract

### Read the Run

The Run detail query supplies the summary, node entries, input, result, pending action, and Artifacts. Node entry behavior is owned by `surfaces/workflow-run/node-logs/DESIGN.md` and is not restated here.

### Pause an active Run

The Run summary exposes one neutral `Pause` action only while the Run is queued or running. Activation reports progress on the button and calls the Run pause endpoint without confirmation. The event stream and Run query update the summary to `paused`; a failure appears next to the control.

### Resume a paused Run

A paused Run exposes one neutral `Resume` action and retains `Cancel run`. Activation reports progress on the button and calls the Run resume endpoint without confirmation. The event stream and Run query return the summary to active execution; a failure appears next to the control.

### Cancel an active Run

The Run summary exposes one destructive `Cancel run` action while the Run is queued, running, waiting for input, or paused. Activation opens a confirmation dialog explaining that only this Run is affected. Confirmation calls the existing Run cancellation endpoint, keeps the dialog controls busy until the request settles, closes on success, and leaves the dialog open with an inline error on failure. The event stream and Run query update the summary to the terminal `cancelled` state; no manual refresh is offered.

### Stay current during an active Run

The route subscribes to the Run event stream and applies events incrementally to cached Run detail. There is no manual refresh control: every value on this page is backed by that stream, so staleness is server-observable. The stream resumes from its last sequence without duplicating events, and a terminal Run closes it.

### Recover a failed or waiting Run

Node-local retry and the durable pending action behave exactly as `shared-states.md` defines, including retry progress on its own control and a pending action that survives reload. This page adds no Run-level rerun, because retry is node-scoped by contract.

### Reach the correlated Provider requests

An Agent or image node links to the Logs `requests` tab filtered to this Run.

## States

| State | Behavior |
| --- | --- |
| Loading | The router's shell-level content-shaped skeleton. Loading, not-found, and load failure are three distinct states, as `shared-states.md` requires of a detail route. |
| Empty | Not applicable; a Run that exists has a status and a summary. A Run with no node entries yet shows its summary and says execution has not reached a node. |
| No results | Not applicable; this page has no filters. |
| Error | A load failure shows a recoverable failure through the router boundary. A missing or non-workspace Run is a distinct not-found state offering the Workflows list. |
| Busy | Cancellation reports progress on its confirmation control and disables dialog dismissal and duplicate submission until the request settles. Pause and resume report progress on their own buttons and prevent duplicate submission. Node retry retains its own control-local progress. |
| Offline | Inherits `shared-states.md`. The reconnecting bar owns transport state and the Run retains the events already received. |
| Long content | Payload and activity containers are bounded per `surfaces/workflow-run/node-logs/DESIGN.md`; the page itself scrolls. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `runs:detail.title` | State |
| `runs:detail.notFound` / `notFoundDescription` | Recovery |
| `runs:detail.noNodeRuns` | State |
| `runs:detail.input` / `result` | State |
| `runs:detail.backToWorkflows` | Action |
| `common:status.paused` | State |
| `runs:pause.action` / `failed` | Action and recovery |
| `runs:resume.action` / `failed` | Action and recovery |
| `runs:cancel.action` / `title` / `description` / `confirm` / `cancelling` / `failed` | Action, state, and recovery |

The Run summary reuses the existing `runs:` status, duration, initiator, and version keys. Node entry copy belongs to `surfaces/workflow-run/node-logs/DESIGN.md`.

## Accessibility

The Run summary is labelled by the page heading. Node entries carry the disclosure semantics defined by the node-log surface. Run status uses the shared status badge with a non-color cue. Keyboard order runs summary, the available pause, resume, or cancellation action when present, node entries in execution order, then input, result, and Artifacts. The cancellation dialog has labelled title and description, visible focus, and progress text independent of the spinner.

## Coverage Status

Verified 2026-09-22. Differences found against the implementation:

- The Workflow editor now enters this route after creating a Run, using the server-returned Run id.

- The route is reached from the Run records dialog; no sidebar entry is added, because a Run is reached through its Workflow rather than as a top-level collection.
- Active Run cancellation is exposed in the page heading and confirmed in a shared Dialog; the implementation uses the existing `api.cancelRun` endpoint and query/event updates. Queued and running Runs also expose pause, while paused Runs expose resume and retain cancellation.
- The route restores no expansion state from the URL, so a shared link opens the Run with every node entry collapsed.

## Changelog

### 2026-09-22

- Added reversible Run pause and resume for eligible active and paused statuses, with neutral control-local progress, a warning paused badge, and failure feedback beside the activated control.
- Extended Run cancellation eligibility to paused Runs while retaining confirmation for that terminal command.

### 2026-09-20

- Added Run-level cancellation for queued, running, and waiting-for-input Runs, with confirmation, control-local progress, failure feedback, and terminal-state streaming.

### 2026-09-21

- Established the Run detail route as the deep log-reading destination alongside the Run records dialog, using available width and reusing the shared node-log and Artifact surfaces.
- Required incremental event application with no manual refresh control, and required loading, not-found, and load failure to remain three distinct states.
- Recorded that Run-level rerun is absent because retry is node-scoped by contract.

### 2026-09-22

- Made Run detail the destination opened after starting a Run from the Workflow editor, using the server-returned Run id.
