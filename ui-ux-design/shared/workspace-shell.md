# Workspace Shell

## Structure

Use a persistent `232px` sidebar, a `52px` context bar, fluid main content, an optional `360px` inspector, and an optional resizable bottom run panel. The sidebar collapses to `56px` only between `768px` and `1023px`.

Primary navigation is grouped and single-level. It contains six direct destinations: **Workspace** contains `Home` and `Workflows`; **Capabilities** contains `Agents` and `Plugins`; **Configuration** contains `Providers` and `Settings`.

Providers owns the Model Providers and Portkey Gateway views in one page context. Agents is the single capability destination for Agent, Skills, and MCP Server page-level tabs; Plugins remains its peer. Workflow List owns execution-history access through its per-Workflow Run records dialog, whose expanded Run rows expose Artifacts inline; direct Artifact details provide deeper inspection. At `1024px` and above, the expanded sidebar shows group labels and all destinations. From `768px` to `1023px`, the compact icon rail uses group separators, direct icons, and tooltips. The mobile navigation drawer uses the same grouped destinations. Usage, audit log, and appearance are reached from Settings. System Helper Chat is available throughout the workspace shell, presented prominently on Home and as a floating control elsewhere. Counts indicate actionable state only. The WorkLite mark is at the top and the personal preferences menu is at the bottom. The expanded preferences control keeps its neutral status label and shows the application version as a right-aligned monospace label; the compact rail exposes the same version inside the preferences menu.

The selected navigation item uses `brand-subtle`, primary text, and a narrow brand indicator. The selected resource link represents its route family: Skills and MCP Server routes select Agents, while Artifact routes select Workflows. Personal preferences stay in the bottom menu.

## Context Bar

Place navigation and breadcrumb context on the left. Place command search, state, secondary actions, and one primary page action on the right. Move low-frequency actions to overflow and never duplicate the primary action in the page heading.

## Panels

The inspector opens only for selected contextual content, keeps its header and essential actions available, scrolls internally, and does not discard unsaved work when closed. It may expand to `440px` for structured configuration.

The workspace shell owns the active conversation execution identifier, the built-in System Helper execution and transient composer draft. Other Agents and published Workflows are selected per message with `@` mentions. Agent selections create Agent turns; Workflow selections create normal Workflow Runs and remain independent from the Agent session. Messages, plugin process state, script requests, automatic execution state, and results remain server-owned. Page navigation closes the visible conversation without cancelling work; a browser reload fetches the active execution identifier and selected target saved by the browser.

Place the System Helper Chat interaction surface at the bottom of the content region on every workspace page. Home keeps the single-line input visible by default. Other pages show only a draggable floating Agent icon in the lower-right corner by default; clicking it opens the same raised conversation panel above the current page and focuses the input. Clicking outside an expanded Chat surface closes it while Chat-owned popup menus remain usable. Keep the icon inside the viewport safe area and preserve a keyboard-accessible open action without a visible Tooltip. Center the complete expanded surface and cap it at `1200px`. With a bound provider the expanded composer contains the single-line input and one stable icon-button target without a repeated visible System Helper Chat title; the target shows Send while idle and Stop while the active turn is running. The input remains editable in both states. Without a bound provider the expanded surface contains a single direct link to `/agents/agt_system_helper_chat` instead of an input or send control. Home and other pages use the same personal session, expanded dimensions, and compact execution summary.

The bottom panel defaults to about `240px`, resizes, and collapses to a status strip. Closing hides but never cancels a run. Logs distinguish timestamp, severity, source and content, and auto-follow only while the user is at the stream end.

## Route Boundaries

The root route owns the pending and error boundaries for every page. An unresolved route renders a content-shaped skeleton inside the stable shell rather than an empty content region; a route that throws renders a recoverable failure whose retry invalidates the router. The sidebar, context bar, and Chat surface remain mounted through both states, so a slow or failed page never collapses the workspace.

There is no separate first-use route family. Home derives first-use completion from persisted server resources, so the shell has no onboarding layout branch and no browser-state onboarding step.

## Command and User Menus

`Command+K` or `Control+K` opens grouped search, recent destinations, navigation and safe creation commands. Destructive actions are excluded. Opening System Helper through the command menu changes the shell-owned conversation state through typed route search and must not rely on an ignored URL flag. The user menu contains the personal workspace identity, Appearance, Keyboard shortcuts, and the application version. Appearance includes the personal theme and language preferences.

## Changelog

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

- Confirmed that the built-in System Helper Agent is the only composer default; other Agents are invoked per message with `@` mentions rather than a target switcher.

### 2026-09-09

- Confirmed that the built-in System Helper Agent is the only composer default; other Agents are invoked per message with `@` mentions rather than a target switcher.

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

- Required command-menu System Helper actions to open the shell-owned conversation through typed route state.

### 2026-08-27

- Kept the System Helper composer editable during execution and made its stable Send target switch to Stop while the transcript owns loading feedback.

### 2026-08-29

- Added a shell-level plugin target picker to the earlier implementation. This behavior is superseded by the 2026-09-09 decision that the composer has one built-in Agent target.

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
