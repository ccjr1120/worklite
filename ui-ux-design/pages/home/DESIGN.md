# Home

## Route

`/home`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/home.tsx`
- `apps/web/src/components/workspace/agent-chat.tsx`

## Purpose

Read the current output of every published Workflow Dashboard board, and reach Chat Bot without leaving the page.

## Primary Task

Read a board's latest output. Action budget: zero — every eligible board renders its own content on arrival, and no board opens a detail view.

Two secondary intents cost one action each: opening an item in a new tab by activating its row, and opening Chat Bot by focusing the composer. Organizing boards into categories is deliberate configuration work rather than the page's primary task; its dialogs are budgeted separately below.

## Layout

Centered content up to `1200px`. The board library fills the content region, grouped into category sections with custom categories first and Uncategorized last. Boards render two per row on desktop and one per row below `md`.

A persistent single-line Chat Bot composer sits at the bottom center of the content region. Board content reserves enough bottom space that the composer never obscures its final rows. The expanded conversation panel rises above the composer, capped at `1200px` by approximately `680px` with at least `24px` desktop outer space; the board list stays mounted beneath it with its scroll position preserved.

## Interaction Contract

### Board library

Boards are derived, not configured here. Eligibility comes from the latest published WorkflowVersion: only a Workflow whose immutable version contains its single `worklite/dashboard` node is listed. Each card loads that Workflow's latest successful Run for the published version through the normal Run query and locates the successful Dashboard node output.

A Workflow is not listed while it is draft, while its latest version has no Dashboard node, or while it has no matching successful Run with a committed Dashboard node output. Home has no platform-defined boards, global Workflow data source, output snapshot, Dashboard editor, scheduling control, or Run now control. Workflow creation and Dashboard configuration remain in the Workflow editor.

Board cards are static surfaces, not full-card selection controls. The header area shows the icon followed immediately by the configured `header` elements — `text`, `count`, and `metric` — resolved against the latest successful Run output, with version, run time, and status metadata aligned right. The content area uses the first `list` element found in main, then header, then footer order, and renders it as a table of up to three columns drawn from its non-`url` fields beginning with the `titleKey` field, falling back to its first display field. Unknown fields are ignored, missing fields display an explicit empty value, and non-object rows display their raw JSON in a bounded monospace region.

A configured `url` field is omitted from secondary list columns and supplies the item link when its value is an `http(s)` string; if selected as `titleKey`, it remains the title column. If the Dashboard layout has no configured `url` field, Home uses the row object's top-level `url` string when it is an `http(s)` URL. Activating the row opens the item link in a new browser tab, and the title cell remains the accessible link. The content area paginates five rows at a time with quiet previous and next controls and a current-page indicator.

Board output is not self-healing. It loads per visit through the Run query; a newer successful Run appears on the next load. Cards carry no refresh control, because the board reflects a completed Run rather than a live value.

### Category organization

Category organization is database-backed through the Home board-category APIs. A compact create control opens a dialog with a labeled name field, a primary create action, a cancel action, and local busy and failure states. Each category exposes rename and delete controls, plus an add control that opens a dialog listing eligible boards as selectable cards.

Selecting a board card in the add dialog assigns that board to the category; selecting an already-assigned card returns the board to Uncategorized. Assignment is a single action with no confirmation, because it is reversible by selecting the card again. Board cards never embed category selectors.

Creating a category costs two actions — name it, then create — because the name is a value the product cannot resolve. Delete-category confirmation follows the shared permanent-removal pattern and states that its boards return to Uncategorized.

Category loading, mutation, and failure states stay local and never remove unaffected boards. Organization controls remain neutral and quiet.

### Embedded Chat Bot

Focusing the composer expands the conversation panel without waiting for a submission. Clicking outside, pressing `Escape`, using the icon-only minimize control, or navigating to another page closes the panel without cancelling work or clearing the conversation.

The minimized dock retains the composer and, after the first request, a compact status summary such as preparing, tool calls in progress, needs review, completed, or failed. The summary carries a non-color cue and reopens the current conversation. Completion does not automatically minimize the panel.

Command search may open or focus Chat Bot through the same Home state. Chat Bot is not a separate sidebar item. Transcript, Skill-call, and session behavior are specified in `../../surfaces/workspace/chat-bot/DESIGN.md`.

### First use

The first-use sequence is optional and resumable, with visible progress and one primary outcome per step. It shows two steps: configure at least one Model Provider, then bind a Provider and model to the protected Chat Bot Agent. The current step owns the primary action; completed steps remain visible but quiet while the sequence is incomplete.

Completion derives from persisted server resources rather than browser preferences. The guide does not appear until both the Provider and Chat Bot queries have resolved successfully, and it disappears as soon as both steps are complete. There is no account or team setup step, and creating a Workflow Agent node, creating a Workflow, or running and inspecting a Workflow are not first-use steps.

## States

| State | Behavior |
| --- | --- |
| Loading | While Workflows, Runs, or categories load, the library region shows a single bounded notice. Each card loads its own Run output independently and shows a local notice inside the card until it resolves. |
| Empty | No eligible board: explain that no Workflow has a published Dashboard node with a successful run. An empty category shows its own dashed placeholder without hiding other categories. |
| No results | Not applicable; the library has no filter or search. |
| Error | A failed Workflow, Run, or category query shows a danger-toned notice in place of the library. Category mutation failures show an inline `role="alert"` message local to the affected control or dialog and leave unaffected boards mounted. |
| Busy | Category mutations report on the activated control; the create dialog marks itself `aria-busy` and prevents duplicate submission. |
| Offline | Inherits `shared-states.md`. |
| Long content | Board tables paginate at five rows; cells truncate and non-object rows use a bounded monospace scroller. Long category and board names truncate rather than wrapping the header. |

Card-level Run loading, empty, unavailable, and failure states stay inside the card that owns them.

## Copy Inventory

| Key | Category |
| --- | --- |
| `home:boards.title` | State |
| `home:boards.version` | State |
| `home:boards.loading` | State |
| `home:boards.unavailable` | Recovery |
| `home:boards.empty` | Recovery |
| `home:boards.previousPage` | Action |
| `home:boards.nextPage` | Action |
| `home:boards.pageIndicator` | State |
| `home:boards.emptyValue` | State |
| `home:boards.trueValue` | State |
| `home:boards.falseValue` | State |
| `home:boards.emptyOutput` | State |
| `home:categories.uncategorized` | State |
| `home:categories.nameLabel` | Action |
| `home:categories.namePlaceholder` | Action |
| `home:categories.createTitle` | Action |
| `home:categories.createDescription` | Constraint |
| `home:categories.create` | Action |
| `home:categories.rename` | Action |
| `home:categories.delete` | Action |
| `home:categories.deleteTitle` | Action |
| `home:categories.deleteDescription` | Constraint |
| `home:categories.addBoards` | Action |
| `home:categories.addTitle` | Action |
| `home:categories.addDescription` | Constraint |
| `home:categories.added` | State |
| `home:categories.addEmpty` | State |
| `home:categories.deleting` | State |
| `home:categories.empty` | State |
| `home:categories.unavailable` | Recovery |
| `home:firstUse.intro` | State |
| `home:firstUse.configureProvider` | Action |
| `home:firstUse.configureSystemHelper` | Action |

`home:boards.description` is removed: "Boards published by Workflow Dashboard nodes" restates the `Workflow boards` heading and tells the reader nothing they act on.

`assistant:configuration.hint` ("Changes are saved automatically.") is removed under `shared/copy-standards.md`: the configuration view already shows its saving state, so the sentence describes what a visible component communicates.

`home:categories.createDescription`, `deleteDescription`, and `addDescription` are retained as Constraints because each states a rule the interface does not otherwise show: one category per board, boards returning to Uncategorized on delete, and re-selection unassigning a board.

## Accessibility

Each category is a `section` labelled by its heading, and Uncategorized uses the same structure. Category action buttons are icon-only with accessible names that include the category name. The create dialog binds its label to the name input and autofocuses it.

Board cards are `article` elements. The decorative Dashboard icon is `aria-hidden`. Board tables use `th scope="col"` headers. A row with a resolvable URL keeps its title cell as a real anchor so keyboard users reach the link without depending on the row click, and the anchor stops propagation so the row handler does not double-open it. Pagination is a `nav` labelled by the current page indicator, and its icon-only controls carry accessible names.

Run status uses the shared status badge with a non-color cue. First-use step markers are `aria-hidden` because each step's state is also present as text: either the completed label or the continue action.

## Coverage Status

Checked 2026-09-23 against `apps/web/src/routes/home.tsx` and the deployed Workflow Dashboard output shape. The deployed list output includes a top-level `url` property although its Dashboard layout omits a configured URL field; Home now resolves that shape. Remaining differences found:

- The category-level error banner is driven by one combined `categoryError` flag covering the categories query and all four mutations, so a failed assignment inside the add dialog also paints the page-level banner while the dialog shows its own copy of the same message.
- Board-card Run loading uses `runDetailQuery.isPending`, which is also true when the query is disabled or idle, so a card can sit in its loading notice rather than reaching a resolved state.
- The card content branch collapses four distinct conditions — no list element, query error, absent output, and zero items — into a single `boards.emptyOutput` message, so a failed Run query is presented as an empty board rather than as a failure with recovery.
- `listTableFields(listElement)[0]` is recomputed inside the cell loop and compared by reference to decide which cell is the link, which works only because the helper returns a stable field object from the same element; the coupling is undocumented.
- Category rename has no error surface of its own: a failed rename leaves the inline form open with the page-level banner as its only feedback.
- The board-card pagination `nav` uses the page indicator string as its accessible name, which names the current state rather than the control group.

## Changelog

### 2026-09-23 - Workflow output links

- Resolve item links from the Workflow Dashboard output's top-level `url` property when its layout does not configure a `url` field, while keeping configured URL fields authoritative and hidden from table columns.

### 2026-09-19 - Copy cleanup

- Removed `home:boards.description` from both locales as a restatement of the Workflow boards heading.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, the accessibility section, and verified coverage findings.
- Folded the former Onboarding flow specification into First Use: the sequence is optional, resumable, server-derived, and has no account or team setup step. `flows/onboarding/DESIGN.md` is removed.
- Recorded board output and category organization as non-self-healing with no refresh control, and budgeted category creation at two actions because the name cannot be resolved by the product.
- Removed `home:boards.description` as a restated heading and `assistant:configuration.hint` as text duplicating the visible saving state.

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

- Reduced first use to Provider configuration and Chat Bot Provider-and-model binding, made completion server-derived, and removed the guide after both steps complete.
- Replaced structured proposal review with the persisted Chat Bot transcript and inline Skill-script approvals.

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
