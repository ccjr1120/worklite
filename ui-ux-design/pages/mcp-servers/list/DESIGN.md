# MCP Server List

## Route

`/mcp-servers`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/mcp-servers/index.tsx`
- `apps/web/src/features/mcp-servers/delete-dialog.tsx` (shared with the configuration surface)

## Purpose

Find a connected MCP server and open it, check which servers are reachable, or connect a new one.

## Primary Task

Open the server being looked for. Action budget: one — activate the row, which is a single link to its configuration.

## Layout

Fluid collection width up to `1440px`. A page heading sits above the shared resource navigation; MCP Servers is the third tab. A toolbar carries the filter on the left and `Connect MCP server` on the right, directly above the table. Columns are Server, Connection, Transport, Allowed tools, Version, and a fixed-width Actions column.

Rows emphasize name, connection status, transport, allowed-tool count, published version, and update time. Connection status and version status remain distinct: a server may be published and unreachable at the same time, so the two must never collapse into one indicator.

## Interaction Contract

Activating a row navigates to `/mcp-servers/:serverId`. Activating `Connect MCP server` navigates to the configuration surface in new-server mode. Both are plain links with no intermediate step.

Typing in the filter narrows the list on each keystroke against the server name. The no-results state offers `Clear filters`.

Deleting a server is the one action that costs a second deliberate step, because it is permanent. The row's destructive icon control opens a named confirmation. Confirming reports progress on the confirm control, closes the dialog on success, shows a toast, and refetches the list. When the server is still referenced, the rejection stays inside the dialog as a concrete list of every referencing location: Agent assignments, the current Chat configuration, active Chat turns, Workflow drafts and published versions with their node ids, and Team roles and captured Team versions. References that force deletion can clean — Workflow drafts and active Team roles — appear with an unchecked-by-default force checkbox that the reader must actively check before confirming again; checking it removes those references in place in the same transaction as the deletion. Chat configuration, active-turn, and Agent assignment references can never be force-cleaned and instead state that they must be removed at their source. Published Workflow versions and captured Team versions are immutable history: they keep their references, and the dialog states that re-running them reports the server as unavailable.

A failed load offers `Try again`, which refetches in place.

Connection status is a stale value this surface does not heal. It reflects the last server-side handshake rather than live reachability, and this collection carries no poll. A row therefore reports what was last observed, not what is true now; the configuration surface owns re-testing. Because the list neither polls nor exposes a refresh control, it must not present connection status as live.

## States

| State | Behavior |
| --- | --- |
| Loading | `CollectionLoading` with the table's six columns, inside a `role="status"` live region naming the load. |
| Empty | No server connected: name the next step and keep `Connect MCP server` reachable in the toolbar. |
| No results | Names the active filter and offers `Clear filters`. |
| Error | `ErrorState` with `Try again`, preserving the toolbar so the filter is not lost. |
| Busy | Deletion reports on the confirm control; refetch reports on `Try again`. |
| Offline | Inherits `shared-states.md`. |
| Long content | Long server names truncate in their cell with the exact value reachable. |

Unreachable and authentication-failure conditions are per-row connection states carried by the shared status badge, not page-level states. Credentials are never rendered in any row.

## Copy Inventory

| Key | Category |
| --- | --- |
| `mcpServers:title` | State |
| `mcpServers:create` | Action |
| `mcpServers:search` | Action |
| `mcpServers:loading` | State |
| `mcpServers:loadFailed` | Recovery |
| `mcpServers:empty.title` | State |
| `mcpServers:empty.description` | Recovery |
| `mcpServers:noMatches.title` | State |
| `mcpServers:noMatches.description` | State |
| `mcpServers:columns.server` | State |
| `mcpServers:columns.connection` | State |
| `mcpServers:columns.transport` | State |
| `mcpServers:columns.allowedTools` | State |
| `mcpServers:columns.version` | State |
| `mcpServers:columns.actions` | State |
| `mcpServers:delete.action` | Action |
| `mcpServers:delete.title` | State |
| `mcpServers:delete.description` | Constraint |
| `mcpServers:delete.deleting` | State |
| `mcpServers:delete.success` | State |
| `mcpServers:delete.failed` | Recovery |
| `mcpServers:delete.references.title` | Constraint |
| `mcpServers:delete.references.agent` / `chatConfiguration` / `activeChatTurns` | Constraint |
| `mcpServers:delete.references.workflowDraft` / `workflowVersion` | Constraint |
| `mcpServers:delete.references.agentTeamRole` / `agentTeamVersion` | Constraint |
| `mcpServers:delete.force.label` / `immutableLabel` | Action |
| `mcpServers:delete.force.immutableNote` | Constraint |
| `mcpServers:delete.force.blockedNote` | Recovery |
| `common:status.connected` | State |
| `common:status.disconnected` | State |
| `common:status.unreachable` | State |
| `common:status.auth_failed` | State |
| `common:actions.clearFilters` | Action |
| `common:actions.delete` | Action |
| `common:actions.cancel` | Action |

`mcpServers:description` is removed. "Remote Streamable HTTP connections, discovered tools, and published versions." restates the column headers below it; the transport constraint belongs on the configuration surface where the user acts on it.

`mcpServers:empty.description` is retained as Recovery: "Connect a remote MCP server, test it, then choose the tools agents may use." names the next steps rather than defining the object.

## Accessibility

The filter input takes its accessible name from its placeholder contract. `Tab` reaches the filter, `Connect MCP server`, then each row link followed by its delete control. The row link must present a visible focus indicator that follows the row shape.

Connection status uses the shared status badge, which pairs an icon and a text label with its color, so status never depends on color alone. The delete control is icon-only and carries an accessible name and tooltip naming the server it removes. The allowed-tool count uses tabular numerals.

## Coverage Status

2026-10-20 source comparison: deletion now runs through the shared `McpServerDeleteDialog`; a reference rejection renders the concrete location list inside the dialog, the force checkbox appears unchecked only when force can clean the remaining references, and the deletion copy names the discovered tool declarations. Earlier findings below remain as recorded.

Verified 2026-09-19. Differences found against `apps/web/src/routes/mcp-servers/index.tsx`:

- The empty state offers no action. `EmptyState` is rendered without `actionLabel`/`onAction`, so the first-use state names the task without providing the entry point the shared rule requires.
- The row link uses `className="contents"`, so the anchor generates no box and its focus ring has nothing to paint on. Keyboard users get no visible row focus.
- Deletion failure renders `error.message` from the transport directly, contradicting the `shared-states.md` requirement that raw errors are never presentation content.
- Dependency-blocked deletion has no distinct presentation. A reference conflict arrives through the same generic failure path, so the user is not told which Agent or Workflow blocks removal.
- The filter is component state only and is not persisted in URL state.
- Truncated server names have no tooltip or other disclosure. The name cell also carries no `truncate`, so a long name stretches its column instead.
- Below `768px` the table keeps `min-w-[860px]` and scrolls horizontally rather than becoming object rows, deviating from `shared/responsive-behavior.md` without recording the deviation.
- `mcpServers:description` needs removal under `shared/copy-standards.md`.

## Changelog

### 2026-10-20 - Reference-protected deletion

- Deletion moves to the shared `McpServerDeleteDialog`: reference rejections list every concrete location in the dialog, an unchecked-by-default force checkbox cleans Workflow draft and Team role references in place, and the deletion copy states that discovered tool declarations are removed with the server.

### 2026-09-19 - Copy cleanup

- Removed `mcpServers:description` from both locales: it defined the object instead of telling the reader anything they act on from the list.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Recorded that connection status on this surface is a last-observed value with no poll and no refresh control, so it must not be presented as live.
- Required the empty state to offer its connect action, a visible row focus indicator, recoverable disclosure for truncated names, and distinct dependency-blocked deletion feedback.
- Removed the page description under the new copy standards.

### 2026-09-14

- Restored MCP Servers as the third page-level tab within the single Agents sidebar destination.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-30

- Placed MCP Servers beneath Agents in the unified sidebar and removed page-level resource navigation.
- Restored MCP Servers as the third page-level Agent resource tab.

### 2026-08-13

- Established the MCP Server List specification.
