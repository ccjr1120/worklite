# Skill List

## Route

`/skills`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/skills/index.tsx`

## Purpose

Find a Skill package and open it, create one, or import one from a folder.

## Primary Task

Open the Skill being looked for. Action budget: one — activate the row, which is a single link to the editor.

## Layout

Fluid collection width up to `1440px`. A page heading sits above the shared Agents resource tab strip; Skills is the second tab. A toolbar carries the filter on the left and `Import Skill` plus `Create skill` on the right, directly above the table. Columns are Skill, Source, Version, Updated, and a fixed-width Actions column.

Rows show name, source type, current version, and update time. Do not show validation or publication state until those operations are real.

Protected built-in Skills appear in the same collection with a non-color `Built-in` source label. The platform-operation capability is owned by System Helper Chat and is not a Skill resource in this collection.

## Interaction Contract

Activating a row navigates to `/skills/:skillId`. Activating `Create skill` navigates to the editor in new-Skill mode. Both are plain links with no intermediate step.

`Import Skill` opens the browser folder picker in one action. The chosen folder is read recursively with relative paths preserved, validated for a root `SKILL.md`, and imported as a new archive-source Skill without executing or assigning it. Success navigates directly to the imported Skill's editor. The control reports its own busy state while the import runs. A rejected folder — missing `SKILL.md`, unreadable files, or a failed import — explains itself next to the toolbar and leaves the list intact.

Typing in the filter narrows the list on each keystroke against the Skill name. The no-results state offers `Clear filters`.

Deleting a Skill is the one action that costs a second deliberate step, because it is permanent. The row's destructive icon control opens a named confirmation. Confirming reports progress on the confirm control, closes the dialog on success, shows a toast, and refetches the list. Deletion is blocked with visible dependency feedback when an Agent or Workflow references the Skill; that feedback stays in the dialog rather than replacing the list.

A failed load offers `Try again`, which refetches in place.

Skill rows are not self-healing. The collection loads per visit with no poll.

## States

| State | Behavior |
| --- | --- |
| Loading | `CollectionLoading` with the table's five columns, inside a `role="status"` live region naming the load. |
| Empty | No Skill exists: name the next step and keep `Create skill` and `Import Skill` reachable in the toolbar. |
| No results | Names the active filter and offers `Clear filters`. |
| Error | `ErrorState` with `Try again`, preserving the toolbar so the filter is not lost. |
| Busy | Import reports on the `Import Skill` control; deletion reports on the confirm control; refetch reports on `Try again`. |
| Offline | Inherits `shared-states.md`. |
| Long content | Long names truncate in their cell with the exact value reachable. |

Import rejection is a durable inline message beside the toolbar, not a toast, so the reason survives until the next attempt.

## Copy Inventory

| Key | Category |
| --- | --- |
| `skills:title` | State |
| `skills:create` | Action |
| `skills:search` | Action |
| `skills:loading` | State |
| `skills:loadFailed` | Recovery |
| `skills:empty.title` | State |
| `skills:empty.description` | Recovery |
| `skills:noMatches.title` | State |
| `skills:noMatches.description` | State |
| `skills:columns.skill` | State |
| `skills:columns.source` | State |
| `skills:columns.version` | State |
| `skills:columns.updated` | State |
| `skills:columns.actions` | State |
| `skills:source.online` | State |
| `skills:source.archive` | State |
| `skills:source.built-in` | State |
| `skills:import.action` | Action |
| `skills:import.importing` | State |
| `skills:import.missingSkillFile` | Recovery |
| `skills:import.readFailed` | Recovery |
| `skills:import.failed` | Recovery |
| `skills:import.defaultName` | State |
| `skills:delete.action` | Action |
| `skills:delete.title` | State |
| `skills:delete.description` | Constraint |
| `skills:delete.deleting` | State |
| `skills:delete.success` | State |
| `skills:delete.failed` | Recovery |
| `common:actions.clearFilters` | Action |
| `common:actions.delete` | Action |
| `common:actions.cancel` | Action |

`skills:description` is removed. "Versioned packages of instructions, scripts, and references." defines what a Skill is, which does not change what the reader does on a list of their own Skills.

## Accessibility

The filter input takes its accessible name from its placeholder contract. `Tab` reaches the filter, `Import Skill`, `Create skill`, then each row link followed by its delete control. The row link must present a visible focus indicator that follows the row shape.

The folder picker input stays screen-reader reachable while visually hidden, and the visible `Import Skill` control is what receives focus and reports busy state. The delete control is icon-only and carries an accessible name and tooltip naming the Skill it removes. The source column renders a text label, so built-in status never depends on color. Import rejection uses `role="alert"`.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/skills/index.tsx`:

- The first-use empty state can be bypassed. The branch tests `all.length === 0`, but `items` also filters out `sk_worklite_platform`. A workspace whose only Skill is that protected platform package falls through to the no-results state and reports no matches for a filter the user never set.
- The empty state offers no action. `EmptyState` is rendered without `actionLabel`/`onAction`, so the first-use state names the task without providing the entry point the shared rule requires.
- The row link uses `className="contents"`, so the anchor generates no box and its focus ring has nothing to paint on. Keyboard users get no visible row focus.
- The filter matches only `item.name`, while the placeholder invites a general search; source and version are not searchable.
- Deletion failure renders `error.message` from the transport directly, contradicting the `shared-states.md` requirement that raw errors are never presentation content.
- Dependency-blocked deletion has no distinct presentation. A reference conflict arrives through the same generic failure path, so the user is not told which Agent or Workflow blocks removal.
- The filter is component state only and is not persisted in URL state.
- Truncated Skill names have no tooltip or other disclosure.
- Below `768px` the table keeps `min-w-[760px]` and scrolls horizontally rather than becoming object rows, deviating from `shared/responsive-behavior.md` without recording the deviation.
- `skills:description` needs removal under `shared/copy-standards.md`.

## Changelog

### 2026-09-19 - Copy cleanup

- Removed `skills:description` from both locales: it defined the object instead of telling the reader anything they act on from the list.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required the first-use empty state to ignore protected packages and to offer its creation action, a visible row focus indicator, durable inline import rejection, and distinct dependency-blocked deletion feedback.
- Removed the page description under the new copy standards.

### 2026-09-14

- Restored Skills as the second page-level tab within the single Agents sidebar destination.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-09-10

- Added folder-based Skill import with preserved relative paths and a required root `SKILL.md`.

### 2026-08-30

- Placed Skills beneath Agents in the unified sidebar and removed page-level resource navigation.
- Restored Skills as the second page-level Agent resource tab.

### 2026-08-27

- Removed archive upload and validation presentation until their APIs are implemented end to end.
- Required Skill rows to represent only persisted name, source, version, update time, and protected capability labels.

### 2026-08-26

- Added the protected `worklite-platform` Skill with a non-color System Helper Chat-only label.

### 2026-08-26

- Simplified executable built-in availability to automatic Unix support or unsupported platform state.

### 2026-08-26

- Added protected built-in Skill labeling and separate executable-capability availability presentation.

### 2026-08-13

- Established the Skill List specification.
