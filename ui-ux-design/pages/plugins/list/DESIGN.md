# Plugin List

## Route

`/plugins`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/plugins/index.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Structure

Plugins is a first-level workspace resource alongside Agents. Use the collection pattern with the plugin name, description, configured executable command, availability state, and update time. The list is read-only; configuration opens from the selected row. Do not add plugin installation, marketplace, upload, or arbitrary runtime registration controls. The page does not display the Agent resource subgroup or another local navigation row.

The built-in `codex-cli-chat` plugin always appears when its workspace configuration exists. Availability is a server-reported state from testing the persisted command and must include a text or icon cue in addition to color. Loading, empty, partial failure, and long-command states remain visible and recoverable.

## Responsive Behavior

At mobile widths, replace the table with object rows that keep the plugin name, availability, and command visible. Keep Plugins reachable through the shared navigation drawer and keep the row keyboard accessible.

## Changelog

### 2026-08-30

- Promoted Plugins from the Agents resource tabs to first-level workspace navigation.

### 2026-08-29

- Established the Plugin List specification for workspace-owned plugin configuration resources.
