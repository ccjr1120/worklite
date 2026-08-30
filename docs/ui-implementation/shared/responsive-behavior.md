# Responsive Behavior

## Wide Desktop

At `1280px` and above, expand the sidebar, allow side-by-side inspectors, and retain useful table columns. Agent Chat uses the same centered panel up to `1200px` wide and approximately `680px` high on Home and other pages, constrained by `24px` outer space. Its message region keeps `16px` horizontal padding, and automatic Skill execution regions remain inline as compact collapsed disclosure rows.

## Compact Desktop and Tablet

From `768px` to `1279px`, allow the icon rail, hide low-priority columns, and let inspectors overlay or reduce content according to task importance. Constrain the Agent Chat panel within `16px` to `24px` outer space on every page, and keep expanded Skill arguments, execution states, and bounded results inside the transcript column.

## Mobile

Below `768px`, use a navigation drawer, retain page identity, state and primary action in the context bar, convert inspectors to full-screen or bottom sheets, replace wide tables with object rows, preserve vertical workflow steps, and show detailed logs full-screen or in a resizable sheet. The drawer preserves the desktop hierarchy, including the Agents subgroup and first-level Plugins destination; resource pages do not add horizontally scrollable navigation tabs. Agent Chat keeps `12px` outer space and uses at most about `70vh`; it does not become full-screen. Its single-line composer remains reachable above browser controls, and Chat and Proposed changes use internal views. Essential touch controls may grow to `40px` to `44px`.

Responsive layouts must not remove status, recovery, or cancellation controls. The Agent composer retains a stable Send-or-Stop target and editable input at every breakpoint; working feedback remains in the scrollable transcript rather than consuming composer space. Onboarding uses a centered column with `20px` horizontal padding and no decorative side panel.

## Changelog

### 2026-08-30

- Replaced responsive Agent resource tabs with the shared hierarchical navigation drawer and icon-rail menu.

### 2026-08-29

- Required mobile object rows for collections and retained compact access to Settings and Agent resource navigation.

### 2026-08-27

- Kept Agent Skill calls as compact disclosure rows across breakpoints, with expanded metadata and bounded output contained inside the transcript.
- Required editable Agent drafts, transcript loading, and the stable Send-or-Stop control at every breakpoint.

### 2026-08-27

- Replaced responsive approval controls with inline automatic Skill execution state and results.

### 2026-08-27

- Removed responsive proposal-inspector behavior and kept persisted Skill approvals inline at every breakpoint.

### 2026-08-26

- Added the `1200px` wide-screen cap and `16px` message padding for Agent Chat.

### 2026-08-25

- Applied responsive behavior to one personal workspace without team switching or team-specific overlays.

### 2026-08-24

- Unified Home and cross-page Agent Chat panel width and expanded height across responsive breakpoints.

### 2026-08-20

- Replaced full-content Agent Chat expansion with constrained Home panels and lower-right cross-page popovers.
- Defined responsive behavior for the embedded Home conversation, persistent composer, and proposal review.

### 2026-08-14

- Onboarding no longer uses a decorative side panel; the centered column is the layout at every breakpoint.

### 2026-08-13

- Extracted breakpoint and adaptive-layout requirements.
