# Workflow Versions

## Route

`/workflows/:workflowId/versions`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/workflows/$workflowId.versions.tsx`

## Purpose

Read which immutable versions of this Workflow exist, and when each was published.

## Primary Task

Identify the version a Run bound to. Action budget: zero — the list is the answer. Opening the editor from a row costs one further action.

## Layout

Details width up to `1200px`. A breadcrumb chain of Workflows, the Workflow name, and Versions sits above the page heading. The body is one compact table: version identifier, publication time, publisher, step count, and the row's open action. Version identifiers are copyable; publication times and step counts use tabular numerals.

## Interaction Contract

Activating a row's open action navigates to the Workflow editor. Copying a version identifier reports on the copy control itself.

Versions are immutable, so nothing on this surface goes stale and no self-healing value exists. The list loads once per visit with no poll: a new version appears only when the user publishes one, which happens in the editor rather than here.

Running from this surface, when it exists, must name the exact immutable version it targets. Comparison between versions is offered only when the differences can be represented accurately; an approximate diff is worse than none.

## States

| State | Behavior |
| --- | --- |
| Loading | Content-shaped skeleton rows inside the table frame, in a `role="status"` live region naming the load. The breadcrumb and heading stay in place so the shell does not shift. |
| Empty | No published versions: explain that publishing locks the definition and enables runs. |
| No results | Not applicable; this surface has no filters. |
| Error | `ErrorState` with a retry action, preserving the breadcrumb and heading. |
| Busy | Retry reports on its own control; copy reports on the copy control. |
| Offline | Inherits `shared-states.md`. |
| Long content | Many versions scroll the table. Long publisher values truncate with their complete value reachable. |

An unavailable Workflow reference identifies what is missing without leaking protected detail.

## Copy Inventory

| Key | Category |
| --- | --- |
| `workflows:versions.title` | State |
| `workflows:versions.description` | Constraint |
| `workflows:versions.empty.title` | State |
| `workflows:versions.empty.description` | Recovery |
| `workflows:versions.columns.version` | State |
| `workflows:versions.columns.published` | State |
| `workflows:versions.columns.publisher` | State |
| `workflows:versions.columns.steps` | State |
| `workflows:versions.columns.actions` | State |
| `workflows:versions.loading` | State |
| `workflows:versions.loadFailed` | Recovery |
| `common:actions.open` | Action |
| `common:copy.identifier` | Action |

`workflows:versions.description` is retained as a Constraint: its second clause states that Runs always bind to an exact version, which the reader cannot infer from a list of version rows and which explains why versions are not editable.

`workflows:versions.columns.recentRun` is removed together with the column it labels. The column rendered `common:empty.dash` for every row in every case, so it was a heading over permanently absent data. `workflows:versions.columns.actions` replaces it and describes what the final cell actually holds. If run provenance is later wired to real data the column returns with its own key.

## Accessibility

The table is reachable by `Tab` through its copy controls and row open links, in visual order. Copy controls have accessible names naming what they copy. The loading region announces politely. Nothing on this surface encodes state through color.

## Coverage Status

Verified 2026-09-19, resolved 2026-09-19 in the state-completeness pass. The differences found and their resolution:

- No loading state. `useWorkflowVersionsQuery` destructured only `data` with a `[]` default, so a pending query was indistinguishable from a Workflow that has published nothing. Resolved: a pending query renders `CollectionLoading` with the table's columns.
- No error state. `isError` was never read, so a failed load also rendered the empty state. Resolved: a failure renders `ErrorState` with a retry that refetches.
- The Recent run column rendered `common:empty.dash` unconditionally for every row: a column header with no data source. Resolved: the column is removed and its header key is replaced by `versions.columns.actions`, which describes what the cell actually holds.
- The row open action was a `Link` styled as muted text with no focus-visible treatment. Resolved: it uses the shared `focusRing` with its own padded hit area.
- The breadcrumb fell back to `workflows:editor.fallback` while the Workflow query was pending, briefly showing a generic label. Resolved: the Workflow crumb is omitted until its name resolves.

## Changelog

### 2026-09-19 - State completeness

- Added the loading and error states, removed the placeholder Recent run column in favour of an Actions header, gave the open link the shared focus ring, and deferred the Workflow breadcrumb until its name resolves.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required real loading and error states; a pending or failed query must not present itself as an empty version list.
- Removed the Recent run column and its `workflows:versions.columns.recentRun` key because it renders a placeholder for every row with no data source behind it.

### 2026-08-13

- Established the Workflow Versions specification.
