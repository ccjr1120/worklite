# <Page or Surface Name>

Copy this file when adding a route page, flow, or non-route surface. Keep every section and keep them in this order. Delete the guidance lines, not the headings.

## Route

The route path, or the surface's host context when it has no route of its own.

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

Source paths under `apps/web/src/` that own this surface.

## Purpose

One sentence: what the user comes here to accomplish.

## Primary Task

The single most important outcome, its one activation point, and its action budget as defined in `shared/interaction-contract.md`. State the reason when the budget is above one.

## Layout

Regions, widths, and which breakpoint rules from `shared/responsive-behavior.md` apply. Record only what differs from or specialises the shared rules.

## Interaction Contract

One entry per action: what triggers it, the immediate feedback on the activated control, the completion signal, and the recovery path on failure.

Name the poll, event stream, or query that keeps each self-healing value fresh. Record every deviation from `shared/interaction-contract.md` together with its reason.

## States

| State | Behavior |
| --- | --- |
| Loading | |
| Empty | |
| No results | |
| Error | |
| Busy | |
| Offline | |
| Long content | |

Write `Inherits shared-states.md` where the shared rule applies unchanged. Remove rows that cannot occur on this surface and say why in the row above the table only when the absence is surprising.

## Copy Inventory

| Key | Category |
| --- | --- |

Locale keys owned by this surface, each assigned one category from `shared/copy-standards.md`: Action, State, Constraint, or Recovery.

## Accessibility

Keyboard path through the primary task, focus order, accessible names for icon-only controls, and the non-color cue for every status shown here.

## Coverage Status

`Verified <date>` or `Pending verification`. When verified, list the differences found between this document and the implementation. An empty list is stated explicitly.

## Changelog

### YYYY-MM-DD

- What changed and why.
