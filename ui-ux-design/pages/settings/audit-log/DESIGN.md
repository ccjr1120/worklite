# Audit Log Settings

## Route

`/settings/audit-log`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/audit-log.tsx`

## Purpose

Review what happened in this workspace, in order, with enough identity and metadata to investigate a specific change.

## Primary Task

Find the events relevant to an investigation. Action budget: one — type into the filter. Results update as the query changes; there is no separate apply action.

## Layout

Fluid collection width up to `1440px` with the Settings local navigation. A filter toolbar sits above a compact chronological table of time, actor, action, resource, and metadata. Timestamps and metadata use tabular numerals and the monospace stack respectively.

## Interaction Contract

Typing in the filter narrows the list on each keystroke against actor, action, and resource. Clearing the filter restores the complete list through the no-results state's `Clear filters` action.

A failed load offers `Try again`, which refetches in place.

Audit events are not self-healing. They load once per visit with no poll: the log is read to investigate a past change rather than to watch live activity. New events appear on the next load.

## States

| State | Behavior |
| --- | --- |
| Loading | `CollectionLoading` with the table's five columns, inside a `role="status"` live region naming the load. |
| Empty | No events recorded: explain that workspace actions appear here as they occur. This is distinct from the no-results state. |
| No results | Names the active filter and offers `Clear filters`. |
| Error | `ErrorState` with `Try again`, preserving the toolbar so the filter is not lost. |
| Busy | Refetch shows its progress on the `Try again` control. |
| Offline | Inherits `shared-states.md`. |
| Long content | Long resources and metadata truncate in their cells; the exact value stays reachable. Pagination applies once the API exposes it. |

Secrets are never exposed in metadata. Exact timestamps and useful identifiers stay intact with copy access.

## Copy Inventory

| Key | Category |
| --- | --- |
| `settings:audit.title` | State |
| `settings:audit.description` | Constraint |
| `settings:audit.search` | Action |
| `settings:audit.noMatches.title` | State |
| `settings:audit.noMatches.description` | State |
| `settings:audit.columns.time` | State |
| `settings:audit.columns.actor` | State |
| `settings:audit.columns.action` | State |
| `settings:audit.columns.resource` | State |
| `settings:audit.columns.metadata` | State |
| `settings:audit.loading` | State |
| `settings:audit.loadFailed` | Recovery |

`settings:audit.description` is retained as a Constraint: its second clause states that secrets are redacted from metadata, which the reader cannot infer and which affects whether they trust the log as complete. The first clause restating the title is removed from the string.

## Accessibility

The filter input has a visible label or an accessible name from its placeholder contract. The loading region announces politely. Truncated resource and metadata cells expose their complete value on hover and keyboard focus. Rows are not interactive, so no row-level focus target is introduced.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/settings/audit-log.tsx`:

- Empty and no-results states are conflated. The single `items.length === 0` branch always renders `audit.noMatches.*` with a `Clear filters` action, so a workspace with no audit events at all is described as having no matches for a filter that is not set.
- Metadata and resource cells truncate with no tooltip or other disclosure, so a truncated value is unrecoverable.
- No copy access for identifiers, which this specification requires.
- `settings:audit.description` needs its redundant leading clause removed while its redaction constraint is kept.

## Changelog

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required distinct empty and no-results states and recoverable disclosure for truncated metadata.
- Kept the redaction constraint in the page description and removed its restated title clause.

### 2026-08-13

- Established Audit Log Settings.
