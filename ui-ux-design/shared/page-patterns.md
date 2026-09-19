# Page Patterns

## Families

- Collections: title, optional description, search, filters, active chips, and right-aligned primary actions in the toolbar directly above the compact table or object list.
- Details: durable summary, metadata, relationships, activity and output.
- Editors: task-focused workspace, persistent save state, contextual configuration and immutable-version context.
- Settings: local navigation and a focused form column, not a card dashboard.

## Widths

Home is centered up to `1200px`; collections are fluid up to `1440px`; settings and forms use `720px` to `840px`; details use up to `1200px`; editors and logs use available width.

## Collections

Keep status near the name, use predictable sortable columns, preserve useful filters in URL state, expose row actions to pointer and keyboard users, and make truncated identifiers copyable. Use bulk actions only for proven repeated work.

## Persistent Tab State

All page-level tabs must persist the selected tab in the route URL through a named Search parameter. The default tab is used when the parameter is missing or invalid. Changing tabs updates the URL without changing the page's visual shell, and a refresh or direct link restores the selected tab. Tab parameters must be validated at the route boundary so unsupported values never select an undefined view.

## Editors and Versions

Show `Saving`, `Saved`, and `Unsaved changes`. Distinguish mutable drafts from immutable published versions. Validation navigates directly to affected content. Publish actions explain immutability and locked dependencies.

## Filter and View State

A filter, tab, or expansion that a user would expect to survive a refresh or a shared link belongs in validated route search state, not in `window.location` read directly or in browser history side effects. Validate the parameter at the route boundary so an unsupported value resolves to the default rather than selecting an undefined view. When several filters describe one investigation, persist them together; restoring part of a view produces a different view.

## Acceptance Checklist

A page defines route and workspace context, one primary action with a declared action budget, both themes, applicable states, keyboard behavior, accessible names, responsive behavior, persistent state ownership, security-sensitive behavior, and semantic-token usage. Its `DESIGN.md` follows `../TEMPLATE.md` and records a dated coverage verification.

## Changelog

### 2026-09-19

- Required refresh-surviving filter, tab, and expansion state to live in validated route search state, and required related filters to persist together.
- Added the declared action budget and dated coverage verification to the page acceptance checklist.
- Removed the Onboarding page family and its column width after the `/onboarding` route family was removed; first use is a server-derived sequence inside Home.
- Made the collection description optional, matching the copy standards.

### 2026-09-11

- Standardized page-level tab persistence through validated URL Search parameters so refreshes and direct links retain the selected view.

### 2026-08-14

- Documented the focused onboarding column width and the absence of a decorative side panel.

### 2026-08-13

- Extracted page families, sizing, collection grammar and acceptance requirements.
