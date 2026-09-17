# Artifact Run Card Presentation

## Route

`Not a standalone route; embedded in Workflow run records and run results.`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/features/workflows/run-history-dialog.tsx`
- `apps/web/src/components/workspace/agent-chat.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Structure

There is no standalone Artifact collection route or execution tab. Successful `worklite/artifact` node execution creates Artifacts; they are presented in the expanded Run row inside the Workflow List Run records dialog and in direct Artifact details. A Run-card artifact row emphasizes name, type, useful size metadata, creation time, and provenance context; its name links to `/artifacts/:artifactId`.

The expanded Run row renders Artifact disclosure only when the Run's immutable Workflow version contains an Artifact node. Eligible runs define loading, empty, failure, and long-collection states; runs whose versions cannot produce Artifacts omit the section entirely. Artifact deletion remains available from Artifact details.

## Changelog

### 2026-09-15

- Limited Run Artifact disclosure and its empty state to immutable Workflow versions that contain an Artifact node.


### 2026-09-15

- Defined successful Artifact-node execution as the source of Run-created Artifacts.

### 2026-09-15

- Moved expandable Run artifact presentation into the per-Workflow Run records dialog after removing standalone Run routes.

### 2026-09-14

- Removed the standalone Artifact list route and moved Artifact collection presentation into expandable Run cards.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.

### 2026-08-13

- Established the Artifact List specification.
