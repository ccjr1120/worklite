# MCP Server Configuration

## Route

`/mcp-servers/{new,:serverId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/mcp-servers/$serverId.tsx`

## Purpose

Connect a remote MCP server and choose which of its tools agents may use.

## Primary Task

Save a working connection with its allowed-tool set. Action budget: one — `Save`.

Save performs the connection handshake as part of committing. Connecting is not a separate goal: a saved MCP server that has never handshaken has no discovered tools and cannot be used, so testing was always a mandatory preparation step for the same intent. Per `shared/interaction-contract.md`, that preparation runs inside the commit rather than as its own action. There is no standalone `Test connection` control.

Discovery makes allowed-tool selection an iteration rather than a second goal: the first `Save` commits the endpoint and returns the tool list, and each subsequent `Save` commits a revised selection through the same single action.

## Layout

Focused editor column at `840px`. The context bar holds the breadcrumb, the save indicator, the destructive delete icon for saved servers, and `Save`. The form column holds name, endpoint, and masked authentication, then the connection outcome, then the allowed-tool checkbox set. Tool names use the monospace stack.

## Interaction Contract

`Save` reports progress on itself, commits the draft, performs a real server-side MCP handshake, and replaces the displayed discovery result with the returned tools. It never fabricates success or tool names. On success the save indicator reads `Saved`, the connection outcome shows its status badge, and allowed selections that no longer match a discovered tool are dropped. A new server navigates to its own route on first save without losing state.

A handshake failure keeps the draft intact, leaves the save indicator at `Unsaved changes` only when persistence itself failed, and states the reason next to the connection outcome: authentication failure, unreachable endpoint, unsupported protocol, or malformed response. Persistence failure and handshake failure are reported separately, because the recovery differs — credentials versus reachability.

Existing drafts restore their endpoint and persisted allowed-tool selection on load. Secrets are never read back: an empty authentication field preserves the stored token, and a non-empty value replaces it.

Publication language appears only when an immutable MCP version is actually created. Save language is used for draft persistence.

Delete is a separate intent and keeps its own confirmation, per the permanent-removal exception in `shared/interaction-contract.md`. Dependency conflicts remain visible in the named confirmation dialog; successful deletion returns to the MCP server list.

No value on this surface is self-healing. Connection state changes only as a result of a handshake the user commits, so there is no poll and no manual refresh.

## States

| State | Behavior |
| --- | --- |
| Loading | Existing servers show field-shaped skeletons for name, endpoint, and authentication inside a `role="status"` live region. The form must not render empty inputs that later fill in, because that looks like cleared user input. |
| Empty | No tools discovered yet: explain that saving the connection discovers its tools. Distinct from a server that handshakes successfully and genuinely exposes none. |
| No results | Not applicable; this surface has no filtering. |
| Error | Persistence failure shows an inline `role="alert"` message above the fields. Handshake failure shows its credential-safe reason next to the connection outcome. Both preserve the draft. |
| Busy | `Save` reports on itself and prevents duplicate submission through its own busy state, leaving the fields editable. |
| Offline | Inherits `shared-states.md`. |
| Long content | Long endpoints and tool names wrap or truncate with their complete value reachable. Discovered descriptions render as untrusted text. |

Never reveal full credentials or log secrets. Render discovered descriptions and MCP output as untrusted content. Make version and allowed-tool consequences clear at publication.

## Copy Inventory

| Key | Category |
| --- | --- |
| `mcpServers:config.new` | State |
| `mcpServers:config.fallback` | State |
| `mcpServers:config.title` | State |
| `mcpServers:config.description` | Constraint |
| `mcpServers:config.name` | State |
| `mcpServers:config.endpoint` | State |
| `mcpServers:config.authentication` | State |
| `mcpServers:config.tokenPlaceholder` | State |
| `mcpServers:config.allowedTools` | State |
| `mcpServers:config.noTools` | Recovery |
| `mcpServers:config.saved` | State |
| `mcpServers:config.saveFailed` | Recovery |
| `mcpServers:config.testErrors.authentication` | Recovery |
| `mcpServers:config.testErrors.unreachable` | Recovery |
| `mcpServers:config.testErrors.unsupported_protocol` | Recovery |
| `mcpServers:config.testErrors.malformed_response` | Recovery |
| `mcpServers:delete.*` | Constraint, Action |
| `mcpServers:config.loading` | State |
| `mcpServers:config.loadFailed` | Recovery |
| `common:actions.save` | Action |
| `common:actions.cancel` | Action |

`mcpServers:config.test` and `mcpServers:config.testing` are removed with the standalone control they label. `config.testErrors.*` are retained as Recovery: the handshake still runs inside `Save`, so its failure reasons still reach the user and each names a different fix.

`mcpServers:config.saveHint` is removed. Its first clause describes what `Save` self-evidently does; its untrusted-content clause is a rendering rule for this specification, not guidance the reader acts on.

## Accessibility

`Tab` reaches name, endpoint, authentication, each tool checkbox, then the context-bar delete and `Save` controls. Every field has a visible label bound by `htmlFor`. The allowed-tool set is a `fieldset` with a `legend`, and each checkbox carries its tool name as its accessible name. Connection status uses the shared status badge with a text label, never color alone. Persistence and handshake failures use `role="alert"` and sit next to what failed. The delete icon control has an accessible name and tooltip naming the server.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/mcp-servers/$serverId.tsx`. Struck entries were resolved in the 2026-09-19 state-completeness pass; the rest await the single-action pass.

- ~~The standalone `Test connection` control still exists and must be removed.~~ Resolved 2026-09-19: `Save` persists and then handshakes in one action, and the standalone control and its `config.test`/`config.testing` keys are gone. The connection outcome renders as a status badge, with a `config.connecting` cue while the handshake runs.
- ~~`Save` does not handshake. Saving alone leaves `testState` untouched, so a user who only saves gets no tools and no connection outcome.~~ Resolved 2026-09-19: the handshake runs inside `Save`, and a persistence failure is reported separately from a handshake failure so a stored draft is not described as unreachable.
- ~~No loading state. `server` is consumed without reading `isLoading`, so an existing server renders empty inputs that are back-filled by the `useEffect`, briefly appearing as cleared fields.~~ Resolved 2026-09-19: an existing server renders field-shaped skeletons until it resolves, a load failure renders `ErrorState` with a retry, and `Save` now reports its own busy state.
- ~~`discoveredTools` is seeded from `allowedToolNames` on load, so restored servers present previously allowed tools as if freshly discovered.~~ Resolved 2026-09-19: the restored set stays visible so it remains deselectable, but `config.toolsRestored` labels it as a saved selection rather than a discovery.
- ~~Empty and pre-discovery tool states are conflated in `config.noTools`, which always reads as an instruction to test.~~ Resolved 2026-09-19: `config.noTools` covers the pre-handshake state and `config.noToolsExposed` covers a server that connects and exposes none.
- ~~`mcpServers:config.saveHint` is still rendered and must be removed under `shared/copy-standards.md`.~~ Resolved 2026-09-19: removed from both locales.

## Changelog

### 2026-09-19 - Single action

- Folded the handshake into `Save`, removed the standalone `Test connection` control and its keys, and split persistence failure from handshake failure.
- Distinguished the pre-handshake, connected-but-empty, and restored-selection tool states, and removed `config.saveHint`.

### 2026-09-19 - State completeness

- Added the loading skeleton and load-failure state for an existing server, and gave `Save` its own busy cue. The Save-absorbs-handshake consolidation remains open for the single-action pass.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Folded the connection handshake into `Save` and removed the standalone `Test connection` action: connecting was a mandatory preparation step for the same goal, not an independent intent.
- Required separate reporting for persistence failure and handshake failure, and a field-shaped loading state for existing servers.
- Removed `config.test`, `config.testing`, and `config.saveHint` under the new copy standards while retaining `config.testErrors.*` as recovery text.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-29

- Required credential-safe endpoint restoration, persisted allowed tools, real server-side connection testing and draft-accurate Save language.

### 2026-08-13

- Established the MCP Server Configuration specification.
