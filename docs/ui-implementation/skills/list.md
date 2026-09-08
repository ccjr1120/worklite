# Skill List

## Structure

Use the collection pattern with the online-create entry point in the right side of the toolbar directly above the table. Skills is the second view in the shared page-level Agent resource tabs. Archive upload remains absent until package upload and extraction are implemented end to end. Rows show name, source type, current version, and update time. Do not show validation or publication state until those operations are real.

Protected built-in Skills appear in the same collection with a non-color `Built-in` source label. The platform-operation capability is owned by System Helper Chat and is not a Skill resource in this collection.

Define empty, uploading, validating, invalid package, filtered no-results, permission and unavailable-file states.

## Changelog

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
