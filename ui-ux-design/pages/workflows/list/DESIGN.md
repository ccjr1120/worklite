# Workflow List

## Route

`/workflows`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/workflows/index.tsx`
- `apps/web/src/features/workflows/run-history-dialog.tsx`

## Purpose

Find a Workflow and either continue building it or inspect what its Runs did.

## Primary Task

Open a Workflow. Action budget: one — activate the row name, which navigates to its editor.

Reading a Workflow's execution history is a second, independent goal and costs one action of its own: the row's Run records control, or the latest-run status, opens the per-Workflow dialog. Both entry points open the same dialog, so this is one goal with one activation point per row region rather than a split intent.

## Layout

Fluid collection width up to `1440px`. The context bar carries a secondary `Import JSON` action and the primary `Create workflow`. A search toolbar sits above the table.

Columns are Workflow, state, last run, updated, and actions. Desktop values stay on one line: the name truncates with its complete value as a tooltip, and narrow layouts scroll horizontally rather than wrapping status, date, or action cells. The last-run timestamp is hover context on its cell while the status itself stays visible.

The Run records dialog is centered, scrolls internally, and preserves keyboard dialog behavior. There is no separate Runs route.

## Interaction Contract

**Open a Workflow.** Activating the row name navigates to the editor.

**Import JSON.** The control opens a local file picker, reads one JSON document, and creates a new draft. Success navigates directly to the imported editor, so the import and the resulting edit are one continuous motion. Invalid documents and unresolved references report concisely. The control reports busy on itself while importing.

**Open Run records.** The Actions-column control opens the dialog scoped to that Workflow. When a Workflow has a latest run, its status is also an interactive control for every status and opens the same dialog; a failed latest run additionally expands the matching Run row so the failure is visible without a further action.

**Stay current.** While the Workflow List is mounted, its collection query polls every five seconds so server-observable latest-run status and update timestamps recover without a manual refresh control. The interval is transport behavior, not user-facing copy.

**Expand a Run.** A dialog row expands in place and lazily loads ordered node execution logs with node identity, status, start time, duration, retry count, and credential-safe error text. Failed Runs show their failure reason before the log list, and the failed node repeats that reason in context. The same detail response states whether the immutable version contains an Artifact node; disclosure follows `../../../surfaces/workflow-run/artifacts/DESIGN.md`.

**Pending authentication.** An expanded waiting Run places its active pending action before the ordered logs, showing the required action's title, description, a `waiting_for_input` status badge, and the QR image.

The QR is self-healing. The dialog subscribes to the Run event stream and replaces a stale or expired code on its own, so the panel carries no manual refresh control, no expiry timestamp, and no instruction to refresh: all three describe work the product now does itself. While a replacement is in flight the existing image stays in place dimmed, accompanied by a status line with a non-color cue. A successful scan replaces the pending panel with continued execution automatically; there is no "I scanned it" control.

**Cancel run.** Cancellation is retained beside the pending action as a neutral secondary control. It is a separate intent — abandoning the work — rather than a recovery from staleness, so `shared/interaction-contract.md` does not fold it into the automatic path. It reports busy on itself.

**Retry node.** A failed Run is recoverable at the node the server marks retryable. The detail response marks at most one node log entry, and only that entry shows a neutral secondary `Retry node` control beside its failure reason. The control reports its own busy state, leaves the surrounding log list and the failure text in place, and relies on the same Run event stream to show continued execution. A rejected retry keeps the original failure reason and adds the rejection reason in the same entry. Retry never appears at the Run level, on other failed entries, or on cancelled and successful entries. The dialog exposes no rerun-from-scratch action.

**Deletion is absent here.** The table exposes no Workflow deletion; it belongs to the editor's destructive action, where the full consequence is stated.

## States

| State | Behavior |
| --- | --- |
| Loading | `CollectionLoading` matching the five-column grid, in a `role="status"` live region naming the load. Inside the dialog, the run list and each expanded section show restrained inline loading lines with non-color cues. |
| Empty | No Workflows: explain that a blank Workflow is created and then configured in the editor. Inside the dialog, a Workflow with no Runs says so. |
| No results | Names the active search and offers `Clear filters`. |
| Error | `ErrorState` with a retry action, preserving the toolbar and the search term. Inside the dialog, a failed run list, log load, or Artifact load explains itself inline without removing the sections beside it. |
| Busy | Import reports on the import control; cancellation and retry report on their own controls. No mutation disables the surrounding region. |
| Offline | Inherits `shared-states.md`. Run events resume without duplication. |
| Long content | Long names truncate with a tooltip. The dialog scrolls internally and keeps the retry control reachable at every breakpoint. |

Validation attention and permission states follow `shared-states.md`.

## Copy Inventory

| Key | Category |
| --- | --- |
| `workflows:title` | State |
| `workflows:create` | Action |
| `workflows:search` | Action |
| `workflows:importJson` | Action |
| `workflows:importing` | State |
| `workflows:importFailed` | Recovery |
| `workflows:empty.title` | State |
| `workflows:empty.description` | Recovery |
| `workflows:noMatches.title` | State |
| `workflows:noMatches.description` | State |
| `workflows:columns.*` | State |
| `workflows:runRecords` | Action |
| `workflows:runRecordsAction` | Action |
| `workflows:latestRunRecordsAction` | Action |
| `workflows:loading` | State |
| `workflows:loadFailed` | Recovery |
| `runs:title` | State |
| `runs:loading` | State |
| `runs:loadFailed` | Recovery |
| `runs:empty.description` | State |
| `runs:logs` | State |
| `runs:logsLoading` | State |
| `runs:logsFailed` | Recovery |
| `runs:noLogs` | State |
| `runs:failureReason` | State |
| `runs:retryCount` | State |
| `runs:nodeRetry.action` | Action |
| `runs:nodeRetry.failed` | Recovery |
| `runs:pendingAction.qrAlt` | State |
| `runs:pendingAction.cancel` | Action |
| `common:status.*` | State |
| `common:duration.compact` | State |
| `common:empty.dash` | State |
| `common:actions.clearFilters` | Action |

`workflows:description` is removed: it defines what a workflow graph is, which does not change what the reader does on a list of their own Workflows.

`runs:pendingAction.expiresAt`, `runs:pendingAction.expired`, and `runs:pendingAction.refresh` are removed together with the manual refresh control. The product replaces the code itself, so an expiry timestamp and an instruction to refresh describe work the user no longer performs — the automation-debt rule in `shared/copy-standards.md`.

## Accessibility

Each row name is a link; the Run records control is an icon-only button with an accessible name naming its Workflow and a tooltip. The latest-run status control has its own accessible name distinguishing it from the Actions-column control. Every run status uses the shared status badge with a text label, never color alone.

In the dialog, each Run row is a `button` carrying `aria-expanded` and `aria-controls` for its detail region, and each section is labelled by its heading. Failure text uses `role="alert"`. The pending-action QR carries an accessible alt name. Spinners are `motion-safe` and always paired with text.

## Coverage Status

Verified 2026-09-22. Struck entries were resolved in the 2026-09-19 single-action pass; the rest remain open.

- ~~The Workflow collection query did not refresh latest-run status and update timestamps while the page was mounted.~~ Resolved: the collection query now polls every five seconds without adding a refresh control.

- ~~`run-history-dialog.tsx` renders the manual `Refresh QR code` button, the `expiresAt` line, and the `expired` instruction alongside the automatic refresh effect that already replaces a stale code.~~ Resolved: the manual control and both strings are gone. Replacement runs from a single effect that attempts each distinct expiry marker once, so an equally stale response cannot spin, and the panel reports `pendingAction.replacing` while a new code arrives.
- The dialog's own run-list loading and failure states are bare paragraphs rather than the shared loading and error treatments, so a failed run list has no retry path.
- ~~`pendingActionBusy` is shared by `refreshPendingAction` and `cancelRun`, so an in-flight automatic refresh disables the cancel control.~~ Resolved: `qrReplacing` and `cancelBusy` are separate, so an automatic replacement never disables cancellation.
- `refreshPendingAction` and `cancelRun` have no failure handling: a rejected call leaves no message, only a cleared busy flag.
- ~~The `pendingActionStale` spinner uses `animate-spin` without the `motion-safe:` prefix.~~ Resolved: the replacement cue uses `motion-safe:animate-spin` and carries its own text.
- `failedNode` picks the first node with `status === 'failed'` while `retryable` is server-marked per entry; the failure-reason banner and the retryable entry are resolved independently and may disagree on which node is authoritative.

## Changelog

### 2026-09-22 - Workflow list freshness

- Added five-second polling while the Workflow List is mounted so latest-run state and update timestamps recover automatically.

### 2026-09-19 - Copy cleanup

- Removed `workflows:description` from both locales: it defined the object instead of telling the reader anything they act on from the list.

### 2026-09-19 - Single action

- Removed the manual `Refresh QR code` control and the expiry and expired strings; a stale code is replaced automatically with a `replacing` status cue, each expiry marker attempted once.
- Separated the replacement and cancellation busy states so cancelling stays available during an automatic replacement.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Removed the pending-action manual QR refresh control, its expiry timestamp, and its refresh instruction: the Run event stream already replaces a stale code, so the panel shows the replacement as state rather than asking for it. `Cancel run` is retained as an independent intent.
- Removed `workflows:description` as a product definition that does not change what the reader does.

### 2026-09-18

- Added a server-marked per-node retry control to the single retryable failed node log entry in expanded Run records, with a control-local busy state, preserved failure text, and no Run-level rerun action.

### 2026-09-16

- Made every available latest-run status open the Workflow's Run records dialog, while retaining automatic expansion for failed latest runs.
- Added persisted pending-action presentation and QR refresh to expanded Workflow Run records.

### 2026-09-15

- Added ordered node execution logs and directly visible failure reasons to expanded Run records.
- Hid Artifact disclosure for immutable Workflow versions without an Artifact node, reserving the empty state for eligible versions.

### 2026-09-15

- Removed the Steps column and moved Run records access into the Actions column.
- Removed direct table deletion; Workflow deletion remains available only inside the editor.
- Made failed latest-run status open and expand the corresponding Run record, with the last-run timestamp available on hover.
- Added a per-row Workflow Run records dialog and removed the standalone Runs routes and navigation destination.
- Presented per-row Run records access as a quiet inline table action aligned with adjacent tabular content.

### 2026-09-10

- Refined deletion feedback so the dialog closes immediately on success and the success toast remains visible.
- Kept Workflow table cells on one line with name truncation and horizontal overflow for narrow layouts.
- Added per-row permanent Workflow deletion with named confirmation, visible failure feedback, and list refresh.

### 2026-09-09

- Added the Import JSON action for creating a new workflow draft from a portable file.

### 2026-08-13

- Established the Workflow List specification.
