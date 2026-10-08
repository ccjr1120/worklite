# Workspace Shell

## Structure

Use a persistent `232px` sidebar, a `52px` context bar, fluid main content, an optional `360px` inspector, and an optional resizable bottom run panel. The sidebar collapses to `56px` only between `768px` and `1023px`.

Primary navigation is grouped and single-level. **Workspace** contains `Chat`, `Workflows`, and `Agent Team`; **Capabilities** contains `Plugins`, with `Skills` and `MCP Servers` available as capability sub-navigation; **Configuration** contains `Providers`, `Logs`, and `Settings`.

Providers owns the Model Providers, Portkey Gateway summary, and Codex account views in one page context. Logs owns Gateway transport observability: request statistics and captured request details over one shared time range. The two are separate destinations because one configures upstream dispatch and the other reads what was dispatched. Skills and MCP Servers are the capability destinations; standalone Agents have no page-level destination; Plugins remains its peer. Workflow List owns execution-history access through its per-Workflow Run records dialog, whose expanded Run rows expose Artifacts inline; direct Artifact details provide deeper inspection. At `1024px` and above, the expanded sidebar shows group labels and all destinations. From `768px` to `1023px`, the compact icon rail uses group separators, direct icons, and tooltips. The mobile navigation drawer uses the same grouped destinations. Usage, audit log, and appearance are reached from Settings. Chat is the first Workspace destination at `/chat`, with direct Web conversation and external-channel inspection. `/home` remains a retained direct route for old links but has no sidebar, brand-mark or command-menu destination; the former Home composer and floating chat control remain removed. Counts indicate actionable state only. The WorkLite mark is at the top and links to `/chat` and the personal preferences menu is at the bottom. The expanded preferences control keeps its neutral status label and shows the application version as a right-aligned monospace label; the compact rail exposes the same version inside the preferences menu.

The selected navigation item uses `brand-subtle`, primary text, and a narrow brand indicator. The selected resource link represents its route family: Agent Team and Agent Team Run routes select Agent Team; Skills and MCP Server routes select Capabilities; Artifact routes select Workflows. The Agent Team destination links directly to `/agent-teams/agent_team_bmad_tea` and has no Team collection destination. Personal preferences stay in the bottom menu.

## Context Bar

Place navigation and breadcrumb context on the left. Place command search, state, secondary actions, and one primary page action on the right. Chat hides shell command search; its page-owned settings action occupies the top-right action area instead. Move low-frequency actions to overflow and never duplicate the primary action in the page heading.

## Panels

The inspector opens only for selected contextual content, keeps its header and essential actions available, scrolls internally, and does not discard unsaved work when closed. It may expand to `440px` for structured configuration.

Chat owns its composer and active conversation inside `/chat`. Its Channels and Configuration sections live in a page-owned settings Dialog, not a shell panel. Conversations and messages are server-owned and discoverable across browsers; the browser only remembers the last selected conversation. Navigation never cancels a running execution. Transient unsent drafts and queues survive route navigation in browser-session memory and disappear on reload; accepted submissions and tasks remain durable. Published Workflow mentions reuse the shared dispatch boundary. The shell mounts no conversation component and has no floating chat entry.

## Route Boundaries

The root route redirects to `/chat` and owns the pending and error boundaries for every page. An unresolved route renders a content-shaped skeleton inside the stable shell rather than an empty content region; a route that throws renders a recoverable failure whose retry invalidates the router. The sidebar and context bar remain mounted through both states, so a slow or failed page never collapses the workspace. Chat is page-owned and is not mounted by the shell.

There is no separate first-use route family. Home derives first-use completion from persisted server resources, so the shell has no onboarding layout branch and no browser-state onboarding step.

## Command and User Menus

`Command+K` or `Control+K` opens grouped search, recent destinations, navigation and safe creation commands. Destructive actions are excluded. Chat is the first navigation command; Home is not listed. The command menu opens `/chat` directly. The user menu contains the personal workspace identity, Appearance, Keyboard shortcuts, and the application version. Appearance includes the personal theme and language preferences.

## Changelog

### 2026-10-08

- Made Chat the first Workspace destination and the root redirect; retained `/home` as a direct route without a navigation entry.
- Hid Chat shell command search, delegated its top-right action area to Chat settings, and moved Channels/Configuration into the page-owned settings Dialog.
- Removed Home from the command menu and linked the WorkLite mark to Chat.

### 2026-10-04

- Added Chat to Workspace navigation and removed the shell-owned floating conversation and Home composer.

### 2026-10-03

- Added `Agent Team` to Workspace navigation as a direct link to the one built-in Team.
- Made Agent Team Run routes part of the Agent Team navigation family without adding a Team collection destination.

### 2026-09-21 - Chat Bot queue ownership

- Gave the shell ownership of the pending Chat Bot message queue alongside the active execution identifier and composer draft, and recorded that a reload drops it because it is session state rather than persisted intent.
- Replaced the remaining `System Helper` references with `Chat Bot`.

### 2026-09-21

- Added `Logs` to the Configuration group as a sixth direct destination for Gateway transport observability, separate from Providers because one configures upstream dispatch and the other reads it.

### 2026-09-19

- Gave the root route the pending and error boundaries for every page, keeping the sidebar, context bar, and Chat surface mounted through both states.
- Removed the onboarding layout branch; first use is a server-derived sequence inside Home.

### 2026-09-15

- Added published Workflow mentions to the embedded chat, including keyboard selection, version-bound Run progress, cancellation, failure feedback, and Artifact links.

### 2026-09-15

- Removed Runs from primary navigation and made Workflow List the access point for per-Workflow Run records; Artifact contexts now select Workflows.

### 2026-09-14

- Added a neutral application-version label to the expanded sidebar preferences control and moved the same version into its compact-rail menu.
- Consolidated primary navigation into seven concise destinations: Skills and MCP Servers moved into the Agents page tabs, while Runs is the execution destination and expandable Run cards provide inline run-to-artifact traceability.
- Moved the expanded sidebar breakpoint from `1280px` to `1024px`, retained the compact icon rail for constrained desktop widths, and synchronized the selected-state treatment with the design system.

### 2026-09-10

- Removed the source-specific Meegle Board destination; workflow-backed boards live inside Home.

### 2026-09-09

- Confirmed that Chat Bot is the protected composer entry; `@` mentions invoke published Workflows rather than user-managed Agents.

### 2026-09-09

- Confirmed that Chat Bot is the protected composer entry; `@` mentions invoke published Workflows rather than user-managed Agents.

### 2026-09-03

- Kept Home's composer visible while changing other pages to a draggable lower-right Chat icon that opens and focuses the shared conversation panel.

### 2026-08-30

- Unified the workspace and Agent resource menus into one hierarchical sidebar, promoted Plugins beside Agents, and nested Skills, MCP Servers, and Providers beneath Agents.
- Kept the non-mobile sidebar expanded so Agents remains a direct single-click destination instead of opening a resource menu.
- Restored the compact icon rail at constrained non-mobile widths with direct links for Agents and each nested Agent resource.
- Replaced the Agents sidebar subgroup with page-level Agent resource tabs while retaining Plugins as a first-level destination.

### 2026-08-29

- Added Plugins to the Agents resource navigation alongside Skills and MCP Servers.

### 2026-08-29

- Required command-menu Chat Bot actions to open the shell-owned conversation through typed route state.

### 2026-08-27

- Kept the Chat Bot composer editable during execution and made its stable Send target switch to Stop while the transcript owns loading feedback.

### 2026-08-29

- Added a shell-level plugin target picker to the earlier implementation. This behavior is superseded by the 2026-09-09 decision that the composer has one built-in Agent target.

### 2026-08-27

- Removed browser-owned Skill permission decisions; the shell now observes server-owned automatic execution state and results.

### 2026-08-27

- Replaced browser-local Chat Bot conversation and proposal ownership with a persisted Agent execution identifier and server-owned messages, approvals, and results.

### 2026-08-27

- Removed Terminal from primary navigation because host execution belongs to saved Skill scripts rather than a generic command surface.

### 2026-08-26

- Centered the shell-level Agent Chat surface and capped its complete width at `1200px`.

### 2026-08-26

- Simplified the configured shell composer to the input and send action while retaining an accessible Agent Chat label.

### 2026-08-26

- Made the shell-level Agent Chat composer conditional on a provider binding and defined the unconfigured setup link.

### 2026-08-25

- Replaced the team switcher and team-scoped shell session with a fixed WorkLite mark and a single personal workspace session.
- Removed team administration and team-specific access-state requirements from the shell.

### 2026-08-24

- Unified Home and cross-page Agent Chat expansion into the same full-width panel and height treatment.
- Reduced primary navigation to the single-level Home, Agents, Workflows, and Settings structure; moved Skills, MCP Servers, and Providers into page-level Agent resource views, moved administrative destinations into Settings, and retained Runs and Artifacts as contextual destinations.

### 2026-08-20

- Defined shell-owned, per-team Agent Chat sessions, route-change closing behavior, and Home versus cross-page presentation modes.
- Embedded Agent Chat in Home and replaced its navigation item with a persistent composer and expandable conversation surface.
- Added Agent Chat as a primary team navigation destination below Home.

### 2026-08-14

- Noted that Appearance includes the personal language preference.

### 2026-08-13

- Extracted the approved workspace shell from the initial implementation specification.
