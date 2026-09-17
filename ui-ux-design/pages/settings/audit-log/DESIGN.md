# Audit Log Settings

## Route

`/settings/audit-log`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/audit-log.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Scope

Use a compact chronological collection with actor, action, resource, timestamp and inspectable metadata. Filters support investigation by actor, action, resource and time when available.

Never expose secrets in metadata. Preserve exact timestamps and useful identifiers with copy access. Define loading, no events, no filter results, redacted metadata, permission and pagination states.

## Changelog

### 2026-08-13

- Established Audit Log Settings.
