# Agent List

## Structure

Use the collection pattern with `Create agent` in the right side of the toolbar directly above the table. The Agents surface provides page-level views for `Agents`, `Skills`, `MCP Servers`, and `Providers`, in that order; these views do not create nested workspace navigation. Each row emphasizes agent name and responsibility, provider and model, assigned Skills and MCP servers, and update time. Do not display version or execution status until Agent publication and execution are backed by real domain behavior. Identity uses a restrained geometric mark or initials, not character artwork.

System Helper Chat is a protected system Agent. It always appears first, carries a visible `Built-in` label, shows its selected provider and model or an unconfigured state in the model column, and never exposes duplication or deletion actions.

Define first-use empty, filtered no-results, loading, partial failure, permission and long-name states. Filters and sort should remain navigable and persist when useful.

## Changelog

### 2026-08-26

- Replaced placeholder Skill summaries with real per-Agent Skill and MCP assignments.
- Removed unsupported Agent version and execution-status columns from the draft-only collection.

### 2026-08-26

- Added the protected System Helper Chat system Agent as the first row with a non-color built-in label and no delete action.

### 2026-08-24

- Added page-level Agent, Skill, MCP Server, and Provider resource views while keeping workspace navigation single-level.

### 2026-08-13

- Established the Agent List specification.
