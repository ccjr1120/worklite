# Run List

## Structure

Use the collection pattern and default to recent runs. Rows show workflow and immutable version, canonical status, current step, start time, duration and initiator. Provide fast status, workflow, initiator and time filters.

Canonical UI labels are `Queued`, `Running`, `Waiting for input`, `Completed`, `Failed` and `Cancelled`. Backend-to-UI status mapping must be explicitly documented when implemented. Live updates must not reorder rows disruptively while a user is interacting.

## Changelog

### 2026-08-13

- Established the Run List specification.
