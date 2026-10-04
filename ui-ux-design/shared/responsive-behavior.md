# Responsive Behavior

## Wide Desktop

At `1024px` and above, expand the sidebar, allow side-by-side inspectors on applicable pages, and retain useful table columns. The Workflow editor keeps its selected-item inspector dock below the diagram. Chat occupies the available workspace at `/chat`, with a conversation history column and an independently scrolling transcript. Its three top tabs keep a stable content height. Home has no composer and the shell has no floating chat entry. Tool execution regions remain inline as compact collapsed disclosure rows.

## Compact Desktop and Tablet

From `768px` to `1023px`, use the `56px` grouped icon rail, hide low-priority columns, and let inspectors overlay or reduce content according to task importance. The Workflow inspector stays in a bounded dock below the diagram; the floating node picker remains anchored over the diagram. Agent resource tabs remain horizontally scrollable within their collection pages, and the Workflow Run records dialog keeps expanded artifact rows readable and its per-node retry control reachable within its scrolling surface. Keep Chat history beside its transcript from `768px`, with expanded Skill arguments, execution states, and bounded result scrollers inside the transcript column.

The Run execution graph scrolls natively on both axes at every desktop width. Its chronological trace remains below the graph, and the selected-node detail dock scrolls independently so retry and payload controls remain reachable.

## Mobile

Below `768px`, use a navigation drawer, retain page identity, state and primary action in the context bar, show the selected Workflow node or edge inspector in a bounded dock below the full-bleed diagram, and keep the floating node picker anchored over the diagram. The inspector dock and diagram scroll independently; the fixed-scale diagram scrolls natively on both axes with touch gestures. Node selection and deletion remain available through the diagram and inspector. Run execution graphs use the same fixed-scale touch scrolling; their chronological trace follows the graph and selected-node details stay in a bounded dock. The drawer preserves every grouped desktop destination named in `workspace-shell.md`, including Plugins and Logs; page-level collection and observability tabs remain reachable through horizontal scrolling, and the Workflow Run records dialog exposes Artifacts through in-place expansion. Chat fills the available workspace and opens conversation history in a Sheet below `768px`. Conversation, Channels, and Configuration tabs stay reachable. Its composer remains reachable above browser controls; the full-record view replaces the transcript visually without losing its scroll position.

A shared time-range control keeps its preset selection and its custom start and end fields reachable at every breakpoint. Below `768px` the presets and the two fields stack in one column rather than dropping the custom range, because a range the reader cannot narrow on a small screen makes the surface unusable there.

Responsive layouts must not remove status, recovery, or cancellation controls, including the per-node retry control on a retryable failed node entry. The Chat composer retains a stable Send-or-Stop target, editable input, and keyboard-accessible published Workflow mention menu at every breakpoint; working feedback remains in the scrollable transcript rather than consuming composer space.

Queued Chat messages keep their rows, count, and per-row remove control inside the scrollable transcript at every breakpoint, and the return-to-end control stays reachable without covering the composer.

## Changelog

### 2026-10-04 - Chat workspace

- Replaced Home and floating conversation surfaces with the dedicated Chat page; kept desktop history and a mobile history Sheet.

### 2026-09-24 - Run execution graph

- Kept the Run graph and chronological trace reachable at constrained widths, with independent scrolling for the graph and selected-node details.

### 2026-09-23 - Workflow node picker

- Kept the Workflow inspector selection-driven on mobile and anchored the node picker to the diagram instead of placing it in the inspector sheet.

### 2026-09-23 - Workflow bottom inspector

- Kept the selected Workflow inspector below the diagram at desktop and mobile widths, with separate scrolling for the dock and diagram.

### 2026-09-23 - Workflow diagram scrolling

- Replaced canvas zoom and pan controls with native two-axis scrolling for the fixed-scale Workflow diagram, including touch scrolling on mobile.

### 2026-09-21 - Chat Bot queue and scroll controls

- Required queued Chat Bot message rows, their count, and their remove controls to stay inside the scrollable transcript at every breakpoint, and the return-to-end control to stay reachable without covering the composer.

### 2026-09-21

- Required a shared time-range control to keep its presets and custom start and end fields reachable at every breakpoint, stacking in one column below `768px`.
- Referred the drawer's destination list to `workspace-shell.md` instead of restating a fixed count, and named Logs among the preserved destinations.

### 2026-09-19

- Removed the onboarding column rule after the `/onboarding` route family was removed; first use is a server-derived sequence inside Home.

### 2026-09-18

- Kept the per-node retry control on a retryable failed node entry reachable at every breakpoint alongside existing status, recovery, and cancellation controls.

### 2026-09-15

- Added published Workflow mentions to the embedded chat, including keyboard selection, version-bound Run progress, cancellation, failure feedback, and Artifact links.

### 2026-09-15

- Adapted the per-Workflow Run records dialog for constrained widths after replacing standalone Run pages.

### 2026-09-14

- Aligned sidebar responsive behavior with concise grouped navigation: expanded at `1024px`, grouped icon rail from `768px` to `1023px`, and the grouped drawer below `768px`.
- Kept related Agent resources and execution outputs reachable through horizontally scrollable page tabs at constrained widths.

### 2026-09-14

- Replaced the separate execution collection tabs with in-place Run-card artifact disclosure.

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
