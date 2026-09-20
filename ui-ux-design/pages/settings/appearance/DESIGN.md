# Appearance Settings

## Route

`/settings/appearance`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/appearance.tsx`
- `apps/web/src/components/theme-provider.tsx`

## Purpose

Choose the personal theme for this workspace. The interface language is fixed to Simplified Chinese.

## Primary Task

Change the theme. Action budget: one. Selecting an option applies and persists it; there is no separate save action.

## Layout

Settings form column at `840px` with the Settings local navigation. Theme options are full-width selectable rows. The selected row uses `border-brand` with `brand-subtle`; unselected rows stay neutral.

## Interaction Contract

Selecting a theme applies it before the next paint and persists the preference. The selection is optimistic: the new value renders at once, and a persistence failure restores the previous value and shows a message below the group.

Theme resolves before first paint so no light-theme flash occurs. The document language is always `zh-CN`.

No self-healing values exist on this surface; nothing here goes stale.

## States

| State | Behavior |
| --- | --- |
| Loading | No blocking load. Theme resolves before first paint from local state. |
| Empty | Cannot occur; both option sets are fixed. |
| No results | Not applicable. |
| Error | Persistence failure restores the previous selection and shows an inline `role="alert"` message below the affected group. |
| Busy | The activated row shows a local pending cue while persistence is in flight; other rows stay interactive. |
| Offline | Inherits `shared-states.md`. The selection stays applied locally and the offline bar explains that it is not yet persisted. |
| Long content | Not applicable. |

Verify that application surfaces, shared editors, charts, diagrams, scrollbars, overlays, and the browser `color-scheme` all follow the resolved theme. Appearance is a personal preference even though its route sits inside Settings.

## Copy Inventory

| Key | Category |
| --- | --- |
| `settings:appearance.title` | State |
| `settings:appearance.theme.title` | State |
| `settings:appearance.theme.system` | Action |
| `settings:appearance.theme.light` | Action |
| `settings:appearance.theme.dark` | Action |
| `settings:appearance.theme.systemDescription` | Constraint |
| `settings:appearance.theme.lightDescription` | Constraint |
| `settings:appearance.theme.darkDescription` | Constraint |
| `settings:appearance.saveFailed` | Recovery |

`settings:appearance.description` and language-related copy are removed because the interface language is fixed.

## Accessibility

The theme radio group is reachable by `Tab` and navigable with arrow keys. Every row is a `label` bound to its `RadioGroupItem`, so the visible text is the accessible name. Icons are `aria-hidden`. Selection is communicated by the radio state and the border change, not by color alone. The failure message uses `role="alert"` and follows the group it belongs to.

## Coverage Status

Updated 2026-09-20. Removed the language setting and documented the fixed Chinese-only interface. Theme persistence remains the only action on this page.

## Changelog

### 2026-09-20 - Chinese-only interface

- Removed language selection from the page and fixed the document language to `zh-CN`.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the declared action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required optimistic application with rollback and a control-local busy cue for both theme and language selection.
- Removed the page and language descriptions as restated headings under the new copy standards.

### 2026-08-29

- Updated appearance verification to cover the shared text editor baseline after removing the unused Monaco dependency.

### 2026-09-14

- Defined pre-paint locale startup using an explicit local preference, browser language, and server preference reconciliation without an English first-paint assumption.

### 2026-08-25

- Defined Appearance as a personal preference surface in the single-user workspace.

### 2026-08-14

- Added a personal language preference to Appearance Settings, alongside theme.

### 2026-08-13

- Established Appearance Settings.
