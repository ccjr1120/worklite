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

Follow a Run's execution node by node to the point where it went wrong. Action budget: one — expand the node entry in question, as specified by `surfaces/workflow-run/node-logs/DESIGN.md`.

## Layout

Available width, following the `page-patterns.md` rule that logs use available width. This is the one Run surface not bounded by a dialog, which is its reason to exist.

A durable Run summary leads: Workflow name, immutable version, status, initiator, start time, and duration. Ordered node entries follow. Run input and result, the pending action when one exists, and Artifacts follow the nodes. Artifact presentation is owned by `surfaces/workflow-run/artifacts/DESIGN.md` and keeps its version-eligibility rule here, so a version that cannot produce Artifacts renders no section.

## Interaction Contract

### Read the Run

The Run detail query supplies the summary, node entries, input, result, pending action, and Artifacts. Node entry behavior is owned by `surfaces/workflow-run/node-logs/DESIGN.md` and is not restated here.

### Stay current during an active Run

The route subscribes to the Run event stream and applies events incrementally to cached Run detail. There is no manual refresh control: every value on this page is backed by that stream, so staleness is server-observable. The stream resumes from its last sequence without duplicating events, and a terminal Run closes it.

### Recover a failed or waiting Run

Node-local retry and the durable pending action behave exactly as `shared-states.md` defines, including retry progress on its own control and a pending action that survives reload. This page adds no Run-level rerun, because retry is node-scoped by contract.

### Reach the correlated Provider requests

An Agent or image node links to the Providers `request-logs` view filtered to this Run.

## States

| State | Behavior |
| --- | --- |
| Loading | The router's shell-level content-shaped skeleton. Loading, not-found, and load failure are three distinct states, as `shared-states.md` requires of a detail route. |
| Empty | Not applicable; a Run that exists has a status and a summary. A Run with no node entries yet shows its summary and says execution has not reached a node. |
| No results | Not applicable; this page has no filters. |
| Error | A load failure shows a recoverable failure through the router boundary. A missing or non-workspace Run is a distinct not-found state offering the Workflows list. |
| Busy | Retry reports on its own control. The page performs no other mutation. |
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

The Run summary reuses the existing `runs:` status, duration, initiator, and version keys. Node entry copy belongs to `surfaces/workflow-run/node-logs/DESIGN.md`.

## Accessibility

The Run summary is labelled by the page heading. Node entries carry the disclosure semantics defined by the node-log surface. Run status uses the shared status badge with a non-color cue. Keyboard order runs summary, node entries in execution order, then input, result, and Artifacts.

## Coverage Status

Verified 2026-09-21. Differences found against the implementation:

- This route is specified and implemented in the same change. It is reached from the Run records dialog; no sidebar entry is added, because a Run is reached through its Workflow rather than as a top-level collection.
- The route restores no expansion state from the URL, so a shared link opens the Run with every node entry collapsed.

## Changelog

### 2026-09-21

- Established the Run detail route as the deep log-reading destination alongside the Run records dialog, using available width and reusing the shared node-log and Artifact surfaces.
- Required incremental event application with no manual refresh control, and required loading, not-found, and load failure to remain three distinct states.
- Recorded that Run-level rerun is absent because retry is node-scoped by contract.
