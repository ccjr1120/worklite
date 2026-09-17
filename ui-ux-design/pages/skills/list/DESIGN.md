# Skill List

## Route

`/skills`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/skills/index.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Structure

Use the collection pattern with the shared Agents page-level tabs. Skills is the second tab. Use Import Skill and Create Skill actions on the right side of the toolbar directly above the table. Import Skill opens the browser folder picker, recursively reads text files with their relative paths, requires a root `SKILL.md`, and creates a new archive-source Skill without executing or assigning it. Rows show name, source type, current version, and update time. Do not show validation or publication state until those operations are real.

Protected built-in Skills appear in the same collection with a non-color `Built-in` source label. The platform-operation capability is owned by System Helper Chat and is not a Skill resource in this collection.

Define empty, uploading, validating, invalid package, filtered no-results, permission and unavailable-file states.

Skill rows expose a separate destructive Delete action. Deletion is blocked with visible dependency feedback when an Agent or Workflow references the Skill. Success closes the dialog, shows a toast, and refreshes the list.

## Changelog

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
