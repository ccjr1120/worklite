# Responsive Behavior

## Wide Desktop

At `1280px` and above, expand the sidebar, allow side-by-side inspectors, and retain useful table columns. Home keeps the Agent Chat composer visible; other pages use a lower-right draggable Chat icon until opened. The expanded Agent Chat panel uses the same centered panel up to `1200px` wide and approximately `680px` high, constrained by `24px` outer space. Its message region keeps `16px` horizontal padding, and automatic Skill execution regions remain inline as compact collapsed disclosure rows.

## Compact Desktop and Tablet

From `768px` to `1279px`, use the `56px` single-level icon rail, hide low-priority columns, and let inspectors overlay or reduce content according to task importance. The workflow contextual Sheet yields to its fixed right-side panel as soon as that panel's desktop breakpoint becomes active. Agent resource tabs remain horizontally scrollable within their collection pages. Keep the Home composer visible and use the draggable lower-right Chat icon on other pages; constrain the expanded Agent Chat panel within `16px` to `24px` outer space, and keep expanded Skill arguments, execution states, and bounded results inside the transcript column.

## Mobile

Below `768px`, use a navigation drawer, retain page identity, state and primary action in the context bar, convert the workflow editor's combined palette and inspector to one full-screen or bottom sheet, keep the workflow canvas full-bleed within its editor region, replace wide tables with object rows, and show detailed logs full-screen or in a resizable sheet. Canvas zoom, fit-to-view, selection, and deletion controls remain reachable with `40px` to `44px` touch targets. The drawer preserves the desktop first-level destinations, including Agents and Plugins; Agent resource collection tabs remain reachable through horizontal scrolling. Home keeps its composer visible; other pages use a draggable lower-right Chat icon with `12px` safe-area margins until opened. Agent Chat uses at most about `70vh`; it does not become full-screen. Its single-line composer remains reachable above browser controls, and Chat and Proposed changes use internal views.

Responsive layouts must not remove status, recovery, or cancellation controls. The Agent composer retains a stable Send-or-Stop target, editable input, and keyboard-accessible `@` Agent mention menu at every breakpoint; working feedback remains in the scrollable transcript rather than consuming composer space. Onboarding uses a centered column with `20px` horizontal padding and no decorative side panel.

## Changelog

### 2026-09-03

- Defined Home's always-visible composer and the draggable lower-right Chat icon for other pages, including mobile safe-area margins.
- Keep the floating entry as an Agent icon without a visible Tooltip and close expanded Chat on outside pointer interaction.

### 2026-09-01

- Unified the workflow node palette and inspector into one responsive Sheet that opens selected-node details and returns to the palette when selection is cleared.
- Required the workflow contextual Sheet to close when the fixed desktop panel becomes available.

### 2026-08-31

- Replaced mobile ordered workflow steps with a full editor-region canvas and drawer-based palette and inspector controls.

### 2026-08-30

- Replaced responsive Agent resource tabs with the shared hierarchical navigation drawer and icon-rail menu.
- Removed the compact icon-rail menu so Agents remains a direct navigation target at every non-mobile width.
- Restored the compact icon rail with direct Agents and nested resource links instead of a resource chooser.
- Returned Agent resource navigation to horizontally scrollable page tabs and kept the sidebar and mobile drawer single-level.

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
