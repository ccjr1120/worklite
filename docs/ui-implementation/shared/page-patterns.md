# Page Patterns

## Families

- Authentication and onboarding: narrow, uninterrupted task flows.
- Collections: title, description, search, filters, active chips, one primary action, and compact table or object list.
- Details: durable summary, metadata, relationships, activity and output.
- Editors: task-focused workspace, persistent save state, contextual configuration and immutable-version context.
- Settings: local navigation and a focused form column, not a card dashboard.

## Widths

Authentication uses a centered `360px` to `400px` column with no decorative side panel. Home is centered up to `1200px`; collections are fluid up to `1440px`; settings and forms use `720px` to `840px`; details use up to `1200px`; editors and logs use available width; onboarding uses `480px` to `640px`.

## Collections

Keep status near the name, use predictable sortable columns, preserve useful filters in URL state, expose row actions to pointer and keyboard users, and make truncated identifiers copyable. Use bulk actions only for proven repeated work.

## Editors and Versions

Show `Saving`, `Saved`, and `Unsaved changes`. Distinguish mutable drafts from immutable published versions. Validation navigates directly to affected content. Publish actions explain immutability and locked dependencies.

## Acceptance Checklist

A page defines route and team context, one primary action, both themes, applicable states, keyboard behavior, accessible names, responsive behavior, persistent state ownership, security-sensitive behavior, and semantic-token usage.

## Changelog

### 2026-08-14

- Documented the authentication column width and the absence of a decorative side panel.

### 2026-08-13

- Extracted page families, sizing, collection grammar and acceptance requirements.
