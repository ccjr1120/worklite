# Diagnostic Logs

## Route

`/settings/logs`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/logs.tsx`

## Purpose

Investigate why a local Provider connection or Gateway operation behaved the way it did, by reading its complete trace.

## Primary Task

Open the trace behind a failure and read its ordered events. Action budget: one — activate the row. Arriving from a Provider test failure's `View logs` costs zero further actions, because the trace filter is already applied.

This surface is distinct from Audit Log: diagnostics describe runtime stages, audit events describe user actions.

## Layout

Fluid collection width up to `1440px` with the Settings local navigation. A filter toolbar with free-text search, level, and stage sits above a compact chronological event table of time, level, trace, provider, stage, status, and message. Activating a row expands its complete trace in place, below the row. Trace identifiers and stages use the monospace stack.

## Interaction Contract

Typing in the filter narrows the list on each keystroke. Level and stage selects narrow it further. The no-results state offers `Clear filters`, which resets all three at once.

Activating a row expands the trace for that row's trace identifier and collapses any other open trace. The same control collapses it again.

A `View logs` action on a Provider test failure opens this page with the matching trace filter applied and that trace expanded. The trace filter persists in URL state so a refresh or a copied link reopens the same investigation, and `Clear trace` removes both the filter and the URL parameter.

Copying a trace identifier reports `Copied` on the control itself and returns to its resting label shortly after.

A failed load offers `Retry`, which refetches in place.

Diagnostic events are not self-healing. They load per visit with no poll, because a trace is read after the fact; new events appear on the next load or refetch.

## States

| State | Behavior |
| --- | --- |
| Loading | Five row-shaped skeletons inside the table frame, in a `role="status"` live region naming the load. The column header stays visible so the frame does not shift. |
| Empty | No diagnostic events recorded: explain that Provider connection tests and Gateway diagnostics appear here. |
| No results | Names the active filtering and offers `Clear filters` for search, level, and stage together. |
| Error | `ErrorState` inside the table frame with `Retry`, preserving the toolbar and the active filters. |
| Busy | Refetch reports on the `Retry` control; copy reports on the copy control. |
| Offline | Inherits `shared-states.md`. |
| Long content | Metadata and raw bodies use bounded scroll regions with copy access. All values render as text; log content is never executed or rendered as HTML. |

Malformed events render their raw value as text rather than failing the row.

## Copy Inventory

| Key | Category |
| --- | --- |
| `settings:logs.title` | State |
| `settings:logs.description` | Constraint |
| `settings:logs.search` | Action |
| `settings:logs.traceFilter` | State |
| `settings:logs.clearTrace` | Action |
| `settings:logs.loading` | State |
| `settings:logs.error` | Recovery |
| `settings:logs.retry` | Action |
| `settings:logs.emptyTitle` | State |
| `settings:logs.emptyDescription` | Recovery |
| `settings:logs.noMatchesTitle` | State |
| `settings:logs.noMatchesDescription` | State |
| `settings:logs.columns.*` | State |
| `settings:logs.details` | State |
| `settings:logs.metadata` | State |
| `settings:logs.duration` | State |
| `settings:logs.copyTrace` | Action |
| `settings:logs.copied` | State |
| `settings:logs.filters.allLevels` | Action |
| `settings:logs.filters.allStages` | Action |
| `settings:logs.levels.*` | State |
| `settings:logs.providerCount` | State |

`settings:logs.description` is retained as a Constraint: it establishes that these traces are local and Provider- or Gateway-scoped, which separates this page from Audit Log. `settings:logs.metadata` is removed if it remains unrendered.

## Accessibility

Each row is a `button` with `aria-expanded` reflecting its trace state, reachable by `Tab` with an inset focus ring. Severity uses an icon and a text label in addition to color, and the raw level is exposed to screen readers. Both filter selects carry accessible names from the column they filter. The loading region announces politely. Bounded scroll regions are keyboard scrollable.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/settings/logs.tsx`:

- The trace filter is read from `window.location.search` and cleared with `window.history.replaceState` instead of typed route search state, so it sits outside the router and is not validated at the route boundary as `shared/page-patterns.md` requires.
- `copied` is a single page-level flag, so copying one trace briefly relabels every visible copy control.
- Level and stage filters are not persisted in URL state; only the trace identifier is, so a copied link restores a partially different view.
- The expanded region reuses the outer row's `expandedEvents` for every detail row, which is correct only because the list is filtered by trace; the coupling is undocumented and fragile.
- `settings:logs.metadata` is defined but never rendered.

## Changelog

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required the trace filter to move into validated route search state and per-control copy feedback.
- Required level and stage filters to persist alongside the trace identifier so copied links restore the same investigation.

### 2026-09-02

- Added the initial diagnostic log page specification for trace-oriented Provider connection troubleshooting.
