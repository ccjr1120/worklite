# Workspace Shell

## Structure

Use a persistent `232px` sidebar, a `52px` context bar, fluid main content, an optional `360px` inspector, and an optional resizable bottom run panel. The sidebar collapses to `56px`.

Primary navigation uses one hierarchical sidebar containing `Home`, `Agents`, `Plugins`, `Workflows`, and `Settings`. `Agents` opens the Agent collection and owns an expandable subgroup containing `Skills`, `MCP Servers`, and `Providers`, in that order. The subgroup expands automatically whenever one of its routes is active and may otherwise be collapsed. Plugins remains at the same indentation and hierarchy as Agents. Resource pages do not repeat this navigation as page-level tabs.

The non-mobile sidebar may use its compact `56px` icon rail at constrained widths. In that mode, Agents remains a direct link to the Agent collection, while Skills, MCP Servers, and Providers remain visible as nested direct icon links beneath it; no resource chooser intercepts the Agents link. The mobile navigation drawer uses the same expanded hierarchy. Usage, audit log, and appearance are reached from Settings. Runs and Artifacts remain available from dashboard widgets, detail links, and command search but are not primary navigation destinations. System Helper Chat is available throughout the workspace shell, presented prominently on Home and as a floating control elsewhere. Counts indicate actionable state only. The WorkLite mark is at the top and the personal preferences menu is at the bottom.

The selected navigation item uses `brand-subtle`, primary text, and a non-color indicator. Personal preferences stay in the bottom menu.

## Context Bar

Place navigation and breadcrumb context on the left. Place command search, state, secondary actions, and one primary page action on the right. Move low-frequency actions to overflow and never duplicate the primary action in the page heading.

## Panels

The inspector opens only for selected contextual content, keeps its header and essential actions available, scrolls internally, and does not discard unsaved work when closed. It may expand to `440px` for structured configuration.

The workspace shell owns the active conversation execution identifier, selected execution target, and transient composer draft. Messages, plugin process state, script requests, automatic execution state, and results remain server-owned. Page navigation closes the visible conversation without cancelling work; a browser reload fetches the active execution identifier and selected target saved by the browser.

Place the System Helper Chat interaction surface at the bottom of the content region on every workspace page. Center the complete surface and cap it at `1200px`. With a bound provider it contains only the single-line input and one stable icon-button target without a repeated visible System Helper Chat title; the target shows Send while idle and Stop while the active turn is running. The input remains editable in both states. Focusing it opens the same raised conversation panel above the current page, with stable outer space around it. Without a bound provider it contains a single direct link to `/agents/agt_system_helper_chat` instead of an input or send control. Home and other pages use the same personal session, expanded dimensions, and compact execution summary.

The bottom panel defaults to about `240px`, resizes, and collapses to a status strip. Closing hides but never cancels a run. Logs distinguish timestamp, severity, source and content, and auto-follow only while the user is at the stream end.

## Command and User Menus

`Command+K` or `Control+K` opens grouped search, recent destinations, navigation and safe creation commands. Destructive actions are excluded. Opening System Helper through the command menu changes the shell-owned conversation state through typed route search and must not rely on an ignored URL flag. The user menu contains Profile, Appearance, Keyboard shortcuts and Sign out. Appearance includes the personal theme and language preferences.

## Changelog

### 2026-08-30

- Unified the workspace and Agent resource menus into one hierarchical sidebar, promoted Plugins beside Agents, and nested Skills, MCP Servers, and Providers beneath Agents.
- Kept the non-mobile sidebar expanded so Agents remains a direct single-click destination instead of opening a resource menu.
- Restored the compact icon rail at constrained non-mobile widths with direct links for Agents and each nested Agent resource.

### 2026-08-29

- Added Plugins to the Agents resource navigation alongside Skills and MCP Servers.

### 2026-08-29

- Required command-menu System Helper actions to open the shell-owned conversation through typed route state.

### 2026-08-27

- Kept the System Helper composer editable during execution and made its stable Send target switch to Stop while the transcript owns loading feedback.

### 2026-08-29

- Added a compact shell-level target picker for the built-in Codex CLI Chat plugin. The picker is available when the plugin is enabled and does not add a new primary navigation surface.

### 2026-08-27

- Removed browser-owned Skill permission decisions; the shell now observes server-owned automatic execution state and results.

### 2026-08-27

- Replaced browser-local System Helper conversation and proposal ownership with a persisted Agent execution identifier and server-owned messages, approvals, and results.

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
