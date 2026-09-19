# Agent List

## Route

`/agents`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/agents/index.tsx`

## Purpose

Find a custom Agent and open it, or create the first one.

## Primary Task

Open the Agent being looked for. Action budget: one — activate the row, which is a single link to the editor. Filtering first is optional and does not add to the budget for a user who can already see the row.

## Layout

Fluid collection width up to `1440px`. A page heading sits above the shared Agents resource tab strip, which links `Agents`, `Skills`, and `MCP Servers` in that order. Each tab is its own route, so the selected view is restored by the URL without a Search parameter. Plugins remains a peer-level workspace capability and Providers remains the dedicated Configuration destination.

Below the tabs, a toolbar carries the filter on the left and `Create agent` on the right, directly above the table. Columns are Agent, Model / provider, Skills / MCP, Updated, and a fixed-width Actions column. The Actions header and its icon control are centered within that column so every row stays aligned.

Each row emphasizes the Agent name and responsibility, provider and model, assigned Skills and MCP servers, and update time. Identity uses a restrained geometric mark or initials, not character artwork. Do not display version or execution status until Agent publication and execution are backed by real domain behavior.

System Helper Chat is a protected system Agent owned by the chat panel. It is not a collection row; its Provider and model configuration is available from the chat panel's Configuration view.

## Interaction Contract

Activating a row navigates to `/agents/:agentId`. Activating `Create agent` navigates to the editor in new-Agent mode. Both are plain links with no intermediate step.

Typing in the filter narrows the list on each keystroke against name, responsibility, model, provider, Skill names, and MCP server names. The no-results state offers `Clear filters`.

Deleting an Agent is the one action that costs a second deliberate step, because it is permanent. The row's destructive icon control opens a named confirmation that states what is removed. Confirming reports progress on the confirm control, closes the dialog on success, shows a toast, and refetches the list. A failure keeps the dialog open with the reason visible, framed in user terms rather than passed through from the transport.

A failed load offers `Try again`, which refetches in place.

Agent rows are not self-healing. The collection loads per visit with no poll; a mutation elsewhere appears after the query is invalidated or on the next visit.

## States

| State | Behavior |
| --- | --- |
| Loading | `CollectionLoading` with the table's five columns, inside a `role="status"` live region naming the load. |
| Empty | No custom Agent exists: explain what an Agent does for the user here and offer `Create agent`. The protected system Agent must not suppress this state. |
| No results | Names the active filter and offers `Clear filters`. |
| Error | `ErrorState` with `Try again`, preserving the toolbar so the filter is not lost. |
| Busy | Deletion reports on the confirm control; refetch reports on `Try again`. |
| Offline | Inherits `shared-states.md`. |
| Long content | Long names and responsibilities truncate in their cells; the exact value stays reachable. Skill and MCP summaries truncate to one line each with their complete list available. |

Permission states cannot occur: this is a single-user personal workspace with no per-resource access control.

## Copy Inventory

| Key | Category |
| --- | --- |
| `agents:title` | State |
| `agents:create` | Action |
| `agents:search` | Action |
| `agents:loading` | State |
| `agents:loadFailed` | Recovery |
| `agents:empty.title` | State |
| `agents:empty.description` | Recovery |
| `agents:noMatches.title` | State |
| `agents:noMatches.description` | State |
| `agents:columns.agent` | State |
| `agents:columns.model` | State |
| `agents:columns.resources` | State |
| `agents:columns.updated` | State |
| `agents:columns.actions` | State |
| `agents:notConfigured` | State |
| `agents:editor.skills` | State |
| `agents:editor.mcpServers` | State |
| `agents:delete.action` | Action |
| `agents:delete.title` | State |
| `agents:delete.description` | Constraint |
| `agents:delete.deleting` | State |
| `agents:delete.success` | State |
| `agents:delete.failed` | Recovery |
| `common:actions.clearFilters` | Action |
| `common:actions.delete` | Action |
| `common:actions.cancel` | Action |
| `common:empty.dash` | State |

`agents:description` is removed. "Configurable work units with a model, instructions, skills, and tools." defines what an Agent is, which does not change what the reader does on a list of their own Agents.

`agents:empty.description` is reclassified as Recovery and must be rewritten. "An agent is a named set of instructions, a model, and the skills or tools it may use." is a product definition; an empty collection names the next step instead.

`agents:builtIn` is removed. System Agents are filtered out of this collection, so the label has no row to appear on.

## Accessibility

The filter input takes its accessible name from its placeholder contract. `Tab` reaches the filter, `Create agent`, then each row link followed by its delete control. The row link must present a visible focus indicator that follows the row shape; a link that generates no box cannot show one.

The delete control is icon-only and carries an accessible name and tooltip naming the Agent it removes. The Skills and MCP summaries each carry a screen-reader-only label so the two icon-led lines are distinguishable without seeing the icon. Unconfigured models read as text rather than as an empty cell.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/agents/index.tsx`:

- The first-use empty state is unreachable in normal operation. The branch tests `all.length === 0`, but `all` includes the protected System Helper Chat system Agent while `items` filters to `kind === 'custom'`. A workspace with no custom Agent therefore falls through to the no-results state and reports "No agents match “”" for a filter the user never set.
- The row link uses `className="contents"`, so the anchor generates no box and its focus ring has nothing to paint on. Keyboard users get no visible row focus.
- Truncated names, responsibilities, and resource lists have no tooltip or other disclosure, so a truncated value is unrecoverable.
- Deletion failure renders `error.message` from the transport directly, which contradicts the `shared-states.md` requirement that failures are explained in user terms and that raw errors are never presentation content.
- The filter is component state only. `shared/page-patterns.md` requires useful filters to persist in URL state; a refresh or a copied link loses the query.
- Below `768px` the table keeps `min-w-[940px]` and scrolls horizontally rather than becoming object rows, which deviates from the mobile rule in `shared/responsive-behavior.md` without recording the deviation.
- `agents:description` and `agents:empty.description` need the copy changes named above, and `agents:builtIn` is defined but unused.

## Changelog

### 2026-09-19 - Copy cleanup

- Removed `agents:description` from both locales: it defined the object instead of telling the reader anything they act on from the list.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required the first-use empty state to ignore protected system Agents, a visible row focus indicator, recoverable disclosure for truncated cells, and user-framed deletion failures.
- Removed the page description and the unused built-in label, and reclassified the empty-state text as Recovery under the new copy standards.

### 2026-09-14

- Restored Agents as the single sidebar destination for Skills and MCP Servers and removed Providers from the Agent resource tabs.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-08-30

- Removed the protected System Helper from the Agent collection; configuration now belongs to the chat panel.

- Replaced the page-level Agent resource tabs with the unified sidebar hierarchy and moved Plugins out of the Agents surface.
- Restored page-level tabs for Agents, Skills, MCP Servers, and Providers while keeping Plugins in first-level navigation.

### 2026-08-29

- Added Plugins to the Agents resource view sequence.

### 2026-08-26

- Replaced placeholder Skill summaries with real per-Agent Skill and MCP assignments.
- Removed unsupported Agent version and execution-status columns from the draft-only collection.

### 2026-08-26

- Added the protected System Helper Chat system Agent as the first row with a non-color built-in label and no delete action.

### 2026-08-24

- Added page-level Agent, Skill, MCP Server, and Provider resource views while keeping workspace navigation single-level.

### 2026-08-13

- Established the Agent List specification.
