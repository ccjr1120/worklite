# Run List

## Structure

Runs is the single execution-history destination. Use a calm card list rather than a separate Artifacts tab. Cards show workflow and immutable version, canonical status, current step, start time, duration and initiator. Provide fast status, workflow, initiator and time filters.

Canonical UI labels are `Queued`, `Running`, `Waiting for input`, `Completed`, `Failed` and `Cancelled`. Backend-to-UI status mapping must be explicitly documented when implemented. Live updates must not reorder rows disruptively while a user is interacting.

## Run Cards

A Run card expands in place and lazily loads its detail. The expanded region shows that run’s Artifacts when present, with name, type, size, creation time, and a direct link to Artifact details. When the run has no Artifacts, show a lightweight `No artifacts` state. Detail loading and failure remain localized to the expanded card. The card also provides an explicit `Open details` action to `/runs/:runId`; the card toggle itself must remain keyboard accessible and separate from nested links.

## Changelog

### 2026-09-14

- Replaced the separate Artifacts tab with expandable Run cards that lazily load run detail and show artifacts inline.

### 2026-08-13

- Established the Run List specification.
