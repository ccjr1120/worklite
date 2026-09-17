# Agent List

## Route

`/agents`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/agents/index.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Structure

Use the collection pattern with `Create agent` in the right side of the toolbar directly above the table. The Agents collection shares page-level tabs with `Skills` and `MCP Servers`, in that order. Plugins remains a peer-level workspace capability and Providers remains the dedicated Configuration destination. Each row emphasizes agent name and responsibility, provider and model, assigned Skills and MCP servers, and update time. Do not display version or execution status until Agent publication and execution are backed by real domain behavior. Identity uses a restrained geometric mark or initials, not character artwork.

System Helper Chat is a protected system Agent owned by the chat panel. It is not a collection row; its Provider/model configuration is available from the chat panel's Configuration view.

Define first-use empty, filtered no-results, loading, partial failure, permission and long-name states. Filters and sort should remain navigable and persist when useful.

Custom Agent rows expose a separate destructive Delete action. The named confirmation explains permanent removal of versions, schedules, executions, sessions, and resource assignments. Success closes the dialog, shows a toast, and refreshes the list; failure remains visible in the dialog. The Actions header and icon action are centered within the same fixed-width grid column so every row remains aligned.

## Changelog

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
