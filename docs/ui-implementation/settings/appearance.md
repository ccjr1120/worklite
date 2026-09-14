# Appearance Settings

## Scope

Offer `System`, `Light` and `Dark` with immediate preview and persisted preference. Explain the active resolved theme when System is selected. Apply changes without a full reload or theme flash.

Offer `English` and `Simplified Chinese` as a personal language preference on the same page. Language names appear in their native form. Resolve the initial locale before first paint from an explicit browser-local choice, then the browser language, then the seeded default preference, with `en` as the final fallback. Apply the selected locale immediately without a full reload or a route change. Follow `docs/internationalization/README.md` for locale resolution, persistence, and fallback.

Verify application surfaces, shared editors, charts, diagrams, scrollbars, overlays and browser `color-scheme`. Appearance is personal even though the route appears within the Settings experience.

## Changelog

### 2026-08-29

- Updated appearance verification to cover the shared text editor baseline after removing the unused Monaco dependency.

### 2026-08-25

- Defined Appearance as a personal preference surface in the single-user workspace.

### 2026-08-14

- Added a personal language preference to Appearance Settings, alongside theme.

### 2026-08-13

- Established Appearance Settings.

### 2026-09-14

- Defined pre-paint locale startup using an explicit local preference, browser language, and server preference reconciliation without an English first-paint assumption.
