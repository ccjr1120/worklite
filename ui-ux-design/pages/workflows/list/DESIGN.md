# Workflow List

## Route

`/workflows`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/workflows/index.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Structure

Use the collection pattern with `Create workflow` and a secondary `Import JSON` action. Import opens a local JSON file and creates a new draft; success navigates directly to the imported editor, while invalid or unresolved references produce concise error feedback. Rows emphasize name, draft or published state, last run status, run-record access, and update time. Provide direct continuation to drafts, clear access to immutable versions, and a per-row Run records dialog in the Actions column.

Each row's Run records icon opens a centered dialog scoped to that Workflow. When a Workflow has a latest run, its status is an interactive control for every status and opens the same dialog; when that latest run failed, the dialog also expands the corresponding failed Run row. Rows in the dialog show immutable version, canonical run status, current step, start time, duration, and initiator. A dialog row expands in place to lazily load ordered node execution logs with node identity, status, start time, duration, retry count, and credential-safe error text. Failed Runs show their failure reason before the log list, and the failed node repeats that reason in context. The same detail response exposes whether the immutable version contains an Artifact node: versions without one omit Artifact disclosure entirely, while eligible versions retain local loading, failure, empty, and populated Artifact states. Artifact names link directly to Artifact details. The dialog scrolls internally, preserves keyboard dialog behavior, and has no separate Runs route.

Expanded waiting Runs place their active pending action before the ordered logs. Login and publish-confirmation actions show a QR image, expiry, a refresh action, and neutral Run cancellation. The dialog listens to normal Run events so a successful scan replaces the pending panel with continued execution automatically.

A failed Run may be retried from the node that failed. The detail response marks at most one node log entry as retryable, and only that entry shows a neutral secondary `Retry node` control beside its failure reason. The control reports its own busy state, leaves the rest of the log list and the failure text in place, and relies on the same Run event stream to show continued execution; a rejected retry keeps the original failure reason and adds the rejection reason in the same entry. Retry is never offered at the Run level, on other failed entries, or on cancelled and successful entries. The dialog exposes no rerun-from-scratch action.

Define first-use guidance, filtered results, validation attention, loading, permission and long-name states.

The table does not expose Workflow deletion; users must open the Workflow editor and use its destructive Delete action. The last-run timestamp is available only as hover context while its status remains visible. Desktop table values remain on one line; the name truncates with its full value available as a tooltip, and narrow layouts scroll horizontally instead of wrapping status, date, or action cells.

## Changelog

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
