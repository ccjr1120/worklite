# MCP Server Configuration

## Route

`/mcp-servers/{new,:serverId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/mcp-servers/$serverId.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Flow

Guide users through endpoint and supported transport, masked authentication, server-side connection test, tool discovery, allowed-tool selection and immutable publication.

Connection tests define pending, success, authentication failure, unreachable endpoint, unsupported protocol and malformed-response states. Never reveal full credentials or log secrets. Render discovered descriptions and MCP output as untrusted content. Make version and allowed-tool consequences clear at publication.

Existing drafts restore their endpoint and persisted allowed-tool selection. Test performs a real server-side MCP handshake and replaces the displayed discovery result with the returned tools; it never fabricates success or tool names. Save persists draft configuration and uses Save language. Publication language appears only when an immutable MCP version is actually created.

Saved MCP servers expose a destructive Delete action. Dependency conflicts remain visible in the named confirmation dialog; successful deletion returns to the MCP server list.

## Changelog

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-29

- Required credential-safe endpoint restoration, persisted allowed tools, real server-side connection testing and draft-accurate Save language.

### 2026-08-13

- Established the MCP Server Configuration specification.
