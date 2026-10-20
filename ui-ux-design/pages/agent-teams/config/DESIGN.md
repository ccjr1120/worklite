# Agent Team Configuration

## Route

`/agent-team-config`. Fixed read-only companion to the records page `/agent-teams/agent_team_bmad_tea`, which remains the Run records page.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`

## Implementation

- `apps/web/src/routes/agent-team-config.tsx`
- `apps/web/src/features/agent-teams/team-config.tsx`

## Purpose

Inspect the one built-in Team's current configuration — basic information, role definitions, and Team memories — without the ability to change it. Chat remains the sole Team write path.

## Primary Task

Read the Team configuration. Action budget: zero write actions; the page owns no mutation control, no form, and no write API call. The only activations are navigation (back to records) and per-role instruction disclosure.

## Layout

Shared detail width up to 1200px. The context bar carries the breadcrumb (`Agent Team / Team 配置`) and a single bordered `返回记录` link. The body stacks three sections: a basic-information card using the shared definition-list grid, a role card per configured role, and the Team memory list. Role cards show model, executor, entry points, Skills, MCP servers, and tools in the same grid, with the full instructions behind a collapsed disclosure. MCP server ids render as their workspace server names, falling back to the raw id when the server no longer exists. Empty fields render the `未设置` placeholder rather than blank space. Both light and dark themes inherit the shared semantic tokens.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Return to records | Navigate to `/agent-teams/agent_team_bmad_tea` in one activation. |
| Expand role instructions | The disclosure control toggles its own label between `展开指令` and `收起指令` and reveals the instructions verbatim in a scrollable preformatted block. |

No value on this page is self-healing: configuration changes only through Chat, so there is no poll and no refresh control. The page performs exactly three read-only queries — the Team, its memories, and the workspace MCP server list used for id-to-name mapping.

## States

| State | Behavior |
| --- | --- |
| Loading | Content-shaped skeletons retain page geometry inside a `role="status"` region. |
| Empty | No roles or no memories: the shared empty state names the absence (`未配置角色。` / `暂无 Team 记忆。`). |
| No results | Not applicable; this surface has no filtering. |
| Error | The shared recoverable error with `Try again`, per query. A memories failure does not replace the Team sections. |
| Busy | Not applicable; the page owns no mutation. |
| Offline | Inherits `shared-states.md`. |
| Long content | Instructions scroll inside a bounded preformatted block; long ids and paths wrap with their complete value preserved. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:config.title` | State |
| `agentTeams:config.description` | Constraint |
| `agentTeams:config.viewConfig` | Action |
| `agentTeams:config.backToRecords` | Action |
| `agentTeams:config.loadFailed` | Recovery |
| `agentTeams:config.notSet` | State |
| `agentTeams:config.overview.*` | State |
| `agentTeams:config.roles.title` / `empty` | State |
| `agentTeams:config.roles.model` / `executor` / `entryPoints` / `skills` / `mcpServers` / `tools` | State |
| `agentTeams:config.roles.showInstructions` / `hideInstructions` | Action |
| `agentTeams:config.memories.title` / `empty` / `allRoles` | State |
| `agentTeams:config.memories.loadFailed` | Recovery |
| `agentTeams:role.*` | State |

## Accessibility

`Tab` reaches the `返回记录` link, then each role's instructions disclosure. The disclosure is a native button whose label names its current action; instructions content is plain text, so it needs no keyboard handling. The `未设置` placeholder is real text, not a color-only cue. Loading regions announce through `role="status"`.

## Coverage Status

Verified 2026-10-20 against `apps/web/src/features/agent-teams/team-config.tsx` and `apps/web/src/routes/agent-team-config.tsx`. Differences found: none. The page is served at the fixed route `/agent-team-config` for the one built-in Team, renders only read-only content, maps MCP ids through the workspace server list with id fallback, keeps instructions collapsed by default, and issues no write call. This was a source review plus the component render test `team-config.test.tsx`; no browser verification was run.

2026-10-20 earlier comparison: verified against `apps/web/src/features/agent-teams/team-config.tsx` when the page was served at the nested route `/agent-teams/:teamId/config`; differences found: none at that time. The nested route was later replaced by the fixed `/agent-team-config` route.

## Changelog

### 2026-10-20 - Fixed configuration route

- Replaced the nested `/agent-teams/:teamId/config` route with the fixed `/agent-team-config` route for the one built-in Team; mutual navigation with the records page is unchanged.

### 2026-10-20

- Established the read-only Team configuration specification: basic information, role cards with collapsible verbatim instructions, MCP id-to-name mapping, and a read-only Team memory list, with mutual navigation to the Run records page.
