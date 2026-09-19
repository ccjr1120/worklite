# Usage Settings

## Route

`/settings/usage`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/usage.tsx`

## Purpose

See which models consumed tokens in this workspace, and at what cost.

## Primary Task

Read consumption. Action budget: zero. This is a read-only surface with no mutation.

## Layout

Settings form column at `840px` with the Settings local navigation. A per-model horizontal bar comparison sits above a detail table of model, tokens, runs, and estimated cost. Bars are proportional to the largest row. Numeric cells use tabular numerals; model identifiers use the monospace stack.

## Interaction Contract

The only action is recovery: a failed load offers `Try again`, which refetches in place.

Usage figures are not self-healing. They load once per visit and carry no poll, because consumption changes on run completion rather than continuously, and the surface is read for review rather than monitoring. Present totals as of load rather than as live values.

## States

| State | Behavior |
| --- | --- |
| Loading | Three bar-shaped skeleton rows in the chart region, inside a `role="status"` live region naming the load. The detail table renders no skeleton and must stay absent rather than showing an empty frame. |
| Empty | No usage recorded: explain that consumption appears after runs produce token usage. Do not render a zero-value chart or an empty table frame. |
| No results | Not applicable; this surface has no filters. |
| Error | `ErrorState` replaces the chart region with `Try again`. The detail table is suppressed rather than rendered empty. |
| Busy | Refetch shows its progress on the `Try again` control. |
| Offline | Inherits `shared-states.md`. |
| Long content | Many models scroll the table; the chart region keeps its own height and does not grow unbounded. |

Charts use theme-aware semantic tokens and carry an accessible text summary. Avoid decorative analytics and unexplained totals.

## Copy Inventory

| Key | Category |
| --- | --- |
| `settings:usage.title` | State |
| `settings:usage.chartLabel` | State |
| `settings:usage.tokens` | State |
| `settings:usage.columns.model` | State |
| `settings:usage.columns.tokens` | State |
| `settings:usage.columns.runs` | State |
| `settings:usage.columns.cost` | State |
| `settings:usage.loading` | State |
| `settings:usage.loadFailed` | Recovery |

`settings:usage.description` is removed: it restates the page title and then asserts that the totals are not decorative, which is a design intention rather than something the reader acts on. `settings:usage.columns.empty` is removed with the empty trailing column it labels.

## Accessibility

The chart region carries `role="img"` with an accessible name from `settings:usage.chartLabel`. Every bar's value is also present as text next to its label, so width is never the only encoding. The loading region announces politely and exposes its label to screen readers only. Tabular numerals keep changing values from shifting the layout.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/settings/usage.tsx`:

- No empty state. With no usage rows the page renders a table header over zero rows and a chart region containing nothing.
- The detail table renders unconditionally, so loading and error states show a bare table header below the skeleton or the error panel.
- The table's fifth column exists only to hold `settings:usage.columns.empty`, an intentionally blank header over empty cells.
- `settings:usage.description` is still rendered and must be removed under `shared/copy-standards.md`.

## Changelog

### 2026-09-19 - Copy cleanup

- Removed `settings:usage.description` and the blank trailing column with its `usage.columns.empty` header and empty cell.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the zero-action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required an explicit empty state and suppression of the detail table during loading and failure.
- Removed the page description and the blank trailing table column under the new copy standards.

### 2026-08-13

- Established Usage Settings.
