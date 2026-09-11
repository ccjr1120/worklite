# MCP Server List

## Structure

Use the collection pattern with `Connect MCP server` in the right side of the toolbar directly above the table. MCP Servers is the third view in the shared page-level Agent resource tabs. Rows emphasize name, connection status, transport, allowed-tool count, published version and update time. Connection and version status remain distinct.

Define first-use guidance, testing, unreachable, authentication failure, filtered no-results, permission and secret-configuration attention states.

MCP server rows expose a separate destructive Delete action. Deletion is blocked with visible dependency feedback when an Agent or Workflow references the server. Success closes the dialog, shows a toast, and refreshes the list.

## Changelog

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-30

- Placed MCP Servers beneath Agents in the unified sidebar and removed page-level resource navigation.
- Restored MCP Servers as the third page-level Agent resource tab.

### 2026-08-13

- Established the MCP Server List specification.
