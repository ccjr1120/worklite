# Agent Team Configuration

## Route

`/agent-teams/:teamId/config`. Read-only configuration of the Team selected by `:teamId`, companion to that Team's records page `/agent-teams/:teamId`. The former `/agent-team-config` path is kept only as a compatibility entry that replaces itself with `/agent-teams/agent_team_bmad_tea/config`, the default Company Project Team.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`

## Implementation

- `apps/web/src/routes/agent-teams/$teamId.config.tsx`
- `apps/web/src/routes/agent-team-config.tsx` (compatibility redirect)
- `apps/web/src/features/agent-teams/team-config.tsx`
- `apps/web/src/features/agent-teams/team-switcher.tsx`

## Purpose

Inspect the selected Team's configuration — basic information, role definitions, and Team memories — without the ability to change it. Chat remains the sole write path for both predefined Teams.

## Primary Task

Read the Team configuration. Action budget: zero write actions; the page owns no mutation control, no form, and no write API call. The only activations are navigation (Team switcher, back to records) and per-role instruction disclosure.

## Layout

Shared detail width up to 1200px. The context bar carries the breadcrumb (`Agent Team / <Team name> / Team 配置`) and a single bordered `返回记录` link. Directly below the heading, the same Team switcher as the records page lists both Teams with the selected Team highlighted; its cards link to the other Team's configuration so the configuration always sits below the selected Team. The body then stacks three sections: a basic-information card using the shared definition-list grid, a role card per configured role, and the Team memory list. Role cards show model, executor, entry points, Skills, MCP servers, and tools in the same grid, with the full instructions behind a collapsed disclosure. MCP server ids render as their workspace server names, falling back to the raw id when the server no longer exists. Empty fields render the `未设置` placeholder rather than blank space. Both light and dark themes inherit the shared semantic tokens.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Switch Team | Activating a switcher card navigates to `/agent-teams/:teamId/config` for that Team in one activation. |
| Return to records | Navigate to `/agent-teams/:teamId` for the same Team in one activation. |
| Open legacy path | `/agent-team-config` replaces itself with `/agent-teams/agent_team_bmad_tea/config` before rendering. |
| Expand role instructions | The disclosure control toggles its own label between `展开指令` and `收起指令` and reveals the instructions verbatim in a scrollable preformatted block. |

Configuration changes only through Chat, so the configuration sections have no poll and no refresh control. The page performs read-only queries only — the Team, its memories, the workspace MCP server list used for id-to-name mapping, and the switcher's Team list and per-Team Run summaries (the latter refresh every five seconds for the active and queued counts).

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
| `agentTeams:switcher.*` / `agentTeams:focus.*` | State |
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

`Tab` reaches the `返回记录` link, then the switcher cards (the selected one carries `aria-current="page"` and the visible `当前` label), then each role's instructions disclosure. The disclosure is a native button whose label names its current action; instructions content is plain text, so it needs no keyboard handling. The `未设置` placeholder is real text, not a color-only cue. Loading regions announce through `role="status"`.

## Coverage Status

Verified 2026-10-21 against `apps/web/src/features/agent-teams/team-config.tsx`, `apps/web/src/routes/agent-teams/$teamId.config.tsx` and `apps/web/src/routes/agent-team-config.tsx`. Differences found: none. The page reads the Team from the route parameter, shows the Team switcher below the heading, links back to the same Team's records, and `/agent-team-config` redirects to the default Team's configuration. Component tests cover the parameterized page and the redirect; no browser verification was run.

Verified 2026-10-20 against `apps/web/src/features/agent-teams/team-config.tsx` and `apps/web/src/routes/agent-team-config.tsx`. Differences found: none in rendered behavior. The fixed route `/agent-team-config` remains scoped to the Company Project Team; Chat selects and configures either predefined Team. The page renders only read-only content, maps MCP ids through the workspace server list with id fallback, keeps instructions collapsed by default, and issues no write call. This was a source review; no runtime or browser verification was run.

2026-10-20 earlier comparison: verified against `apps/web/src/features/agent-teams/team-config.tsx` when the page was served at the nested route `/agent-teams/:teamId/config`; differences found: none at that time. The nested route was later replaced by the fixed `/agent-team-config` route.

## Changelog

### 2026-10-21 - Per-Team configuration

- Parameterized the page as `/agent-teams/:teamId/config` so both predefined Teams expose their read-only configuration below the Team switcher; removed the hard-coded Company Project Team id.
- Kept `/agent-team-config` as a compatibility redirect to the default Company Project Team configuration.

### 2026-10-20 - Company Team scope

- Clarified that this fixed read-only page shows the existing Company Project Team; Chat configures both predefined Teams.

### 2026-10-20 - Fixed configuration route

- Replaced the nested `/agent-teams/:teamId/config` route with the fixed `/agent-team-config` route for the Company Project Team; mutual navigation with its records page is unchanged.

### 2026-10-20

- Established the read-only Team configuration specification: basic information, role cards with collapsible verbatim instructions, MCP id-to-name mapping, and a read-only Team memory list, with mutual navigation to the Run records page.
