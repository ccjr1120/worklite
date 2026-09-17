# Workflow Versions

## Route

`/workflows/:workflowId/versions`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/workflows/$workflowId.versions.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Experience

List immutable versions with version identifier, publication time, publisher, step count and recent run context. A version detail is read-only and identifies every locked Agent version. Provide comparison only when differences can be represented accurately.

Running from this surface must identify the exact immutable version. Empty, loading, permission and unavailable-reference states follow shared rules.

## Changelog

### 2026-08-13

- Established the Workflow Versions specification.
