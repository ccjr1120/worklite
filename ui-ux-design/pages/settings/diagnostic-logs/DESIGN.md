# Diagnostic Logs

## Route

`/settings/logs`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/logs.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Route and Purpose

The page is available at `/settings/logs` under Settings. It is the operator-facing investigation surface for local Provider connection tests and other Gateway diagnostics. It remains distinct from Audit Log: diagnostics describe runtime stages, while audit events describe user actions.

## Structure

Show a page heading with a short description, a filter toolbar, and a compact chronological event list. Filters include free-text search, trace identifier, Provider, severity, stage, and a time range when available. Each row shows timestamp, severity with a non-color cue, trace ID, Provider, stage, duration, status, and a one-line message. Trace IDs are copyable.

Selecting a row opens an inline disclosure or detail sheet for the complete trace. The detail view groups events in sequence and shows request method/path, Gateway state, upstream status, response timing, error type, raw error message, and raw response body when present. Long values use bounded scroll regions with copy access. Treat all values as text; never execute or render HTML from log content.

Provider test failures include a `View logs` action that opens this page with the matching trace filter. Preserve the filter in URL state so refresh and copied links reopen the same investigation.

## States and Accessibility

Define loading, unavailable, empty, no-filter-results, and malformed-event states. Durable API errors remain in the page with a retry action. Rows and disclosure controls are keyboard accessible with visible focus. Severity uses label and icon in addition to color. Light and dark modes use semantic tokens; mobile changes the table to stacked rows and uses a full-screen detail sheet.

## Changelog

### 2026-09-02

- Added the initial diagnostic log page specification for trace-oriented Provider connection troubleshooting.
