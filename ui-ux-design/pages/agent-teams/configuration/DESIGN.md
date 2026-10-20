# Agent Team Configuration — retired

## Route

Retired 2026-10-20. No Team configuration route exists; Chat manages Team configuration, work roles, working practice and memories through protected platform operations.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/README.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

No active page implementation. The former route and components (`$teamId.configuration.tsx`, `team-detail.tsx`, and `team-memories.tsx`) were removed.

## Purpose

There is no separate Team configuration surface; Team administration happens in Chat.

## Primary Task

No page action is available. Action budget: zero.

## Layout

No page is rendered for the retired route.

## Interaction Contract

No direct route action is available. Chat's protected operations own Team administration and report their result in the invoking conversation.

## States

| State | Behavior |
| --- | --- |
| Retired route | No route or page is rendered; there is no redirect or compatibility page. |

## Copy Inventory

| Key | Category |
| --- | --- |
| None | No copy is rendered by this retired surface. |

## Accessibility

No controls are rendered by this retired surface. Chat owns the active administration controls and their focus and status behavior.

## Coverage Status

Verified 2026-10-20. Differences found: the route, page component, Team configuration form and Team memory panel were removed; Chat is the sole administration surface. The route is not redirected.

## Changelog

### 2026-10-20

- Retired the separate Team configuration route and direct form; Chat owns Team administration.

### 2026-10-19

- Pinned the Team Manager at the top of the page as a Chat-style section combining its model, working practice and Team/repository-scoped memory management; working practice and memories now belong to the Manager and are injected into its turns only, and the Team save path accepts Manager model changes.
- Reduced work roles to model and executor choices: instructions, entry points, Skills, MCP servers and tool sets moved to Team Manager conversation management, and the advanced disclosure, its copy keys and the obsolete manager-protected note are removed.

### 2026-10-19

- Made the Team Manager model selector editable: an unconfigured Team Manager model used to fail every Manager Run at execution time, and the selector was the only way to set one.

### 2026-10-19

- Added the protected Team Manager and a dynamic work-role directory whose role CRUD runs through the group conversation. The configuration form reflects the current TeamVersion inputs; captured Runs remain immutable.

### 2026-10-19

- Added a dedicated no-tab configuration page, reachable from the Team work-records page's upper-right action.
