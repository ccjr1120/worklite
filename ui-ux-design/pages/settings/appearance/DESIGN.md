# Appearance Settings

## Route

`/settings/appearance`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/settings/appearance.tsx`
- `apps/web/src/components/theme-provider.tsx`
- `apps/web/src/components/locale-provider.tsx`

## Purpose

Choose the personal theme and interface language for this workspace.

## Primary Task

Change the theme or the language. Action budget: one. Selecting an option applies and persists it; there is no separate save action.

## Layout

Settings form column at `840px` with the Settings local navigation. Theme options and language options are two radio groups of full-width selectable rows. The selected row uses `border-brand` with `brand-subtle`; unselected rows stay neutral.

## Interaction Contract

Selecting a theme applies it before the next paint and persists the preference. Selecting a language applies it immediately without a reload or a route change.

Both selections are optimistic: the new value renders at once, and a persistence failure restores the previous value and shows a message below the groups. Neither selection needs confirmation, because both are reversible in one further action.

Initial resolution happens before first paint in this order: explicit browser-local choice, browser language, seeded default preference, then `en`. Theme resolves through the same pre-paint path so no light-theme flash occurs.

No self-healing values exist on this surface; nothing here goes stale.

## States

| State | Behavior |
| --- | --- |
| Loading | No blocking load. Theme and locale resolve before first paint from local state. |
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
| `settings:appearance.language.title` | State |
| `settings:appearance.saveFailed` | Recovery |

`settings:appearance.description` and `settings:appearance.language.description` are removed. The first restates that preferences are personal and names the resolved theme, which the System option already shows; the second restates its own heading. Language names render from `LOCALE_NATIVE_NAMES` rather than translated keys.

## Accessibility

Each radio group is reachable by `Tab` and navigable with arrow keys. Every row is a `label` bound to its `RadioGroupItem`, so the visible text is the accessible name. Icons are `aria-hidden`. Selection is communicated by the radio state and the border change, not by color alone. The failure message uses `role="alert"` and follows the group it belongs to.

## Coverage Status

Verified 2026-09-19, resolved 2026-09-19. The differences found and their resolution:

- No busy state; `setAppearance` and `setLocale` were fired without any pending cue. Resolved: the activated row shows a spinner beside its label while persistence is in flight.
- No optimistic rollback; a rejected promise set `saveError` but left the failed selection displayed. Resolved: a failure restores the previous value so the interface cannot disagree with the stored preference.
- Both descriptions were still rendered. Resolved: removed from both locales.

## Changelog

### 2026-09-19 - Copy and feedback

- Added the per-row busy cue and optimistic rollback, and removed the page and language descriptions from both locales.

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
