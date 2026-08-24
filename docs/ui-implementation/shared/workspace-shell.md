# Workspace Shell

## Structure

Use a persistent `232px` sidebar, a `52px` context bar, fluid main content, an optional `360px` inspector, and an optional resizable bottom run panel. The sidebar collapses to `56px`.

Primary navigation is a single level containing `Home`, `Agents`, `Workflows`, and `Settings`; it never reveals nested navigation. `Skills`, `MCP Servers`, and `Providers` are resource views within the Agents surface and use page-level view navigation, with Providers last. Members, usage, audit log, and appearance are reached from Settings. Runs and Artifacts remain available from dashboard widgets, detail links, and command search but are not primary navigation destinations. Agent Chat is available throughout the workspace shell, presented prominently on Home and as a floating control elsewhere. Counts indicate actionable state only. The team switcher is at the top and the personal menu at the bottom.

The selected navigation item uses `brand-subtle`, primary text, and a non-color indicator. Team administration stays outside the personal menu.

## Context Bar

Place navigation and breadcrumb context on the left. Place command search, state, secondary actions, and one primary page action on the right. Move low-frequency actions to overflow and never duplicate the primary action in the page heading.

## Panels

The inspector opens only for selected contextual content, keeps its header and essential actions available, scrolls internally, and does not discard unsaved work when closed. It may expand to `440px` for structured configuration.

The workspace shell owns Agent Chat session state. Store independent in-memory messages, draft, proposal, and execution state for each `teamSlug`. Page navigation and team switching close the visible conversation without cancelling work. Returning to a team restores its session in the minimized state; a browser reload clears all local-prototype sessions.

Place a single-line Agent Chat composer at the bottom of the content region on every team page. Focusing it opens the same raised, full-width conversation panel above the current page, with stable outer space around it. Both Home and other team pages use the same team session, expanded dimensions, and compact execution summary.

The bottom panel defaults to about `240px`, resizes, and collapses to a status strip. Closing hides but never cancels a run. Logs distinguish timestamp, severity, source and content, and auto-follow only while the user is at the stream end.

## Command and User Menus

`Command+K` or `Control+K` opens grouped search, recent destinations, navigation and safe creation commands. Destructive actions are excluded. The user menu contains Profile, Appearance, Keyboard shortcuts and Sign out. Appearance includes the personal theme and language preferences.

## Changelog

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
