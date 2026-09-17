# Home

## Route

`/home`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/home.tsx`
- `apps/web/src/components/workspace/agent-chat.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Purpose

Home shows self-contained Workflow boards owned by published Workflow Dashboard nodes, renders each board's latest successful Run output on its card, and provides System Helper Chat without requiring a separate destination.

## Workflow Board Library

Show self-contained Workflow board cards grouped by user-managed categories, with custom categories first and Uncategorized last. Derive eligibility from the latest published WorkflowVersion: only a Workflow whose immutable version contains its single `worklite/dashboard` node is listed. Every eligible board belongs to Uncategorized until it is assigned to exactly one custom category. Render the layout header region in the card title area and display the latest published version and latest Run status or time. Board cards do not open a separate detail view.

Category organization is database-backed through Home board-category APIs. Provide a compact create-category control that opens a dialog with a labeled name field, a primary create action, a cancel action, and local busy and failure states, per-category rename and delete controls, and a per-category add control that opens a dialog listing eligible boards as selectable cards. Selecting a card assigns that board to the category; selecting an already-assigned card returns the board to Uncategorized. Board cards do not embed category selectors. Delete-category confirmation follows the shared permanent-removal pattern and states that its boards return to Uncategorized. Keep organization controls neutral and quiet; category loading, mutation, and failure states remain local and do not remove unaffected boards.

Each card loads its Workflow's latest successful Run for that published version through the normal Run query and locates the successful Dashboard node output. The card title area resolves configured `header` elements such as a `count`. The card content area resolves the first configured `list` element as a compact table using up to its up to first three non-url fields, beginning with the `titleKey` field; a `url` field does not render as a column but makes the item row open the item value in a new browser tab, with the title cell remaining the accessible link. The content area paginates five rows at a time with quiet previous and next controls and a current-page indicator. Unknown fields are ignored, missing fields display an explicit empty value, and non-object list rows display their raw JSON value in a bounded monospace region. Keep run loading, empty, unavailable, and failure states local to the card.

A Workflow is not listed while it is draft, its latest version has no Dashboard node, or it has no matching successful Run with a committed Dashboard node output. Home has no platform-defined Workflow boards, global Workflow data source, Workflow output snapshot, Dashboard editor, scheduling control, or Run now control. Category records reference Workspace and Workflow organization only and never store Workflow output. Workflow creation and Dashboard configuration remain in the Workflow editor.

Library board cards are static board surfaces, not full-card selection controls. The card header area shows the icon followed immediately by the configured header elements (such as a `count`) resolved against the latest successful Run Dashboard output, with the version, run time, and status metadata aligned to the right. The content area uses the first `list` element in the board layout (searched in main, header, then footer order) and renders it as an up-to-three-column paginated table. When the element has a `url` field and the item's value for it is an `http(s)` string, the row opens the item value in a new browser tab. Table titles use that element's `titleKey` and fall back to its first display field. The card renders no extra actions or count text; Dashboard icons, headings, ordinary hover states, and pagination controls remain neutral. Status uses the shared status badge and a non-color cue.

## Embedded System Helper Chat

Keep the self-contained board list mounted as the Home content. Place a persistent, labeled, single-line System Helper Chat composer at the bottom center of the Home content region. The board content reserves enough bottom space that the composer does not obscure its final content.

Focusing the composer expands a raised conversation panel above it without waiting for message submission. The panel occupies most, but not all, of the workspace content region, up to `1200px` by approximately `680px` with at least `24px` desktop outer space. Keep the board mounted beneath the panel and preserve its scroll position. The panel contains the persisted Agent transcript and inline Skill-script approvals defined in `../../surfaces/workspace/system-helper-chat/DESIGN.md`.

Clicking outside, pressing `Escape`, using the icon-only minimize control, or navigating to another page closes the panel without cancelling work or clearing the conversation. The minimized dock retains the composer and, after the first request, a compact status summary such as preparing, tool calls in progress, needs review, completed, or failed. The summary includes a non-color cue and reopens the current conversation. Completion does not automatically minimize the conversation.

Command search may open or focus System Helper Chat through the same Home state, but System Helper Chat is not a separate sidebar item.

## First Use

Show a two-step guided sequence: configure at least one Model Provider, then bind a Provider and model to the protected System Helper Chat Agent. The current step owns the primary action; completed steps remain visible but quiet while the sequence is incomplete.

Derive completion from persisted server resources rather than browser preferences. Do not show the guide until both Provider and System Helper Chat queries have resolved successfully. Remove the complete guide as soon as both steps are complete. Creating a custom Agent, creating a Workflow, and running or inspecting a Workflow are not first-use steps.

## Changelog

### 2026-09-15

- Made board rows with configured HTTP(S) URL values open the item URL in a new browser tab.
- Removed separate board detail navigation and made board cards self-contained with a five-row, up-to-three-column paginated table content area.
- Rendered card list content as compact semantic tables whose up to first three non-url fields, starting with `titleKey`, form the columns.
- Made the configured `url` field navigate the item row to the item value while retaining the title cell as the accessible link.
- Kept board cards as static surfaces with header elements immediately after the card icon and version, run time, and status metadata at the right.
- Adopted the compositional Dashboard layout format and removed the Dashboard description.

### 2026-09-14

- Added board-card item counts with the first five titles bound to the Dashboard node `titleField`, including a first-field fallback for older versions.

### 2026-09-14

- Reordered category groups so Uncategorized is last, replaced board-card category selectors with a per-category add dialog of selectable board cards, and added board-card item counts with the first five item titles from the latest successful Run output.

### 2026-09-14

- Moved category creation into a dialog opened by a compact create-category control, with a labeled name field and local busy and failure states.

### 2026-09-14

- Added database-backed user categories for Workflow Dashboard-node boards, with Uncategorized first and at most one category assignment per board.
- Defined quiet create, rename, delete, and move-board controls while preserving Run-derived board output and neutral Dashboard presentation.

### 2026-09-14

- Removed platform-defined Workflow categories, Workflow widgets, and local dashboard-library editing.
- Added Workflow board selection driven only by the latest published version's `worklite/dashboard` node and its latest successful Run output.
- Defined array/object board rendering, missing-output states, URL-selected board state, and neutral Dashboard presentation.

### 2026-08-27

- Reduced first use to Provider configuration and System Helper Chat Provider-and-model binding, made completion server-derived, and removed the guide after both steps complete.
- Replaced structured proposal review with the persisted System Helper Agent transcript and inline Skill-script approvals.

### 2026-08-25

- Reframed Home as a dashboard library for a single personal workspace.
- Replaced the team setup sequence with an optional provider and first-agent checklist.

### 2026-08-24

- Added explicit pointer-cursor, hover, and disabled-state feedback requirements for Home controls.

### 2026-08-20

- Changed Home Agent Chat to a focus-opened, constrained floating panel with a single-line composer.
- Added the persistent Agent Chat composer, upward-expanding conversation surface, minimized execution summary, and legacy-route behavior.

### 2026-08-13

- Established the initial Home specification.
