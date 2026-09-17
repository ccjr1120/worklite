# MCP Server List

## Route

`/mcp-servers`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/mcp-servers/index.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Structure

Use the collection pattern with the shared Agents page-level tabs. MCP Servers is the third tab. Use `Connect MCP server` in the right side of the toolbar directly above the table. Rows emphasize name, connection status, transport, allowed-tool count, published version and update time. Connection and version status remain distinct.

Define first-use guidance, testing, unreachable, authentication failure, filtered no-results, permission and secret-configuration attention states.

MCP server rows expose a separate destructive Delete action. Deletion is blocked with visible dependency feedback when an Agent or Workflow references the server. Success closes the dialog, shows a toast, and refreshes the list.

## Changelog

### 2026-09-14

- Restored MCP Servers as the third page-level tab within the single Agents sidebar destination.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-30

- Placed MCP Servers beneath Agents in the unified sidebar and removed page-level resource navigation.
- Restored MCP Servers as the third page-level Agent resource tab.

### 2026-08-13

- Established the MCP Server List specification.
