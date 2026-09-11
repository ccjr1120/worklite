# Workflow List

## Structure

Use the collection pattern with `Create workflow` and a secondary `Import JSON` action. Import opens a local JSON file and creates a new draft; success navigates directly to the imported editor, while invalid or unresolved references produce concise error feedback. Rows emphasize name, draft or published state, node count, last run, last run status, and update time. Provide direct continuation to drafts and clear access to immutable versions.

Define first-use guidance, filtered results, validation attention, loading, permission and long-name states.

Each row exposes a separate destructive Delete action without nesting it inside the editor link. Delete opens a confirmation dialog that names the Workflow and explains that drafts, published versions, schedules, and run history are permanently removed. A successful deletion closes the dialog before refreshing the list and presents a success toast. A failed deletion keeps the dialog open and presents the error. Desktop table values remain on one line; the name truncates with its full value available as a tooltip, and narrow layouts scroll horizontally instead of wrapping status, count, date, or action cells.

## Changelog

### 2026-09-10

- Refined deletion feedback so the dialog closes immediately on success and the success toast remains visible.
- Kept Workflow table cells on one line with name truncation and horizontal overflow for narrow layouts.
- Added per-row permanent Workflow deletion with named confirmation, visible failure feedback, and list refresh.

### 2026-09-09

- Added the Import JSON action for creating a new workflow draft from a portable file.

### 2026-08-13

- Established the Workflow List specification.
