# Responsive Behavior

## Wide Desktop

At `1280px` and above, expand the sidebar, allow side-by-side inspectors, and retain useful table columns. Agent Chat uses the same full-width panel up to approximately `680px` high on Home and other team pages, constrained by `24px` outer space. Home may show its proposal inspector beside the message region.

## Compact Desktop and Tablet

From `768px` to `1279px`, allow the icon rail, hide low-priority columns, and let inspectors overlay or reduce content according to task importance. Constrain the Agent Chat panel within `16px` to `24px` outer space on every page and switch proposal review to an internal view when side-by-side content becomes too narrow.

## Mobile

Below `768px`, use a navigation drawer, retain page identity, state and primary action in the context bar, convert inspectors to full-screen or bottom sheets, replace wide tables with object rows, preserve vertical workflow steps, and show detailed logs full-screen or in a resizable sheet. Agent Chat keeps `12px` outer space and uses at most about `70vh`; it does not become full-screen. Its single-line composer remains reachable above browser controls, and Chat and Proposed changes use internal views. Essential touch controls may grow to `40px` to `44px`.

Responsive layouts must not remove status, recovery, approval or cancellation controls. Authentication uses a centered column with `20px` horizontal padding and no decorative side panel.

## Changelog

### 2026-08-24

- Unified Home and cross-page Agent Chat panel width and expanded height across responsive breakpoints.

### 2026-08-20

- Replaced full-content Agent Chat expansion with constrained Home panels and lower-right cross-page popovers.
- Defined responsive behavior for the embedded Home conversation, persistent composer, and proposal review.

### 2026-08-14

- Authentication no longer uses a decorative side panel; the centered column is the layout at every breakpoint.

### 2026-08-13

- Extracted breakpoint and adaptive-layout requirements.
