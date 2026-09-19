# Interaction Contract

This document is the source of truth for how many deliberate actions a WorkLite task may cost and for which failures the product must recover from on its own. `shared-states.md` defines what each state looks like; this document defines who is responsible for leaving that state.

## Single Action

One user goal has exactly one activation point in one region. A goal that is already expressed by a visible control must not also require a second control to take effect.

- Do not split a single intent into a preparation action and a commit action. If a preparation step is always required before the commit, run it inside the commit.
- Do not add a confirmation step to a reversible action. Confirmation is reserved for permanent removal and for publishing an immutable version.
- Do not require a selection the product can already resolve. When exactly one valid value exists, or the last used value is still valid, apply it and act.
- Do not duplicate a primary action in both the context bar and the page body.

A surface that needs more than one action for its primary task must say so in its `DESIGN.md` under Primary Task, with the reason.

## Self-Healing State

When the server can observe that a value is stale, the client recovers without being asked. A manual refresh control is permitted only when staleness is not observable.

Self-healing applies to expired authentication codes, expired tokens, dropped streams, stale quota and usage figures, and any value already backed by a poll or an event stream.

The recovery must be visible as state, not as an instruction. Show that the value is being replaced; do not ask the user to replace it. Cancelling the surrounding work stays available, because cancellation is a separate intent rather than a recovery from staleness.

A surface that keeps a manual refresh control must record in its `DESIGN.md` why staleness cannot be observed.

## Action Budget

Every `DESIGN.md` declares the number of deliberate actions its primary task costs, counted from the moment the surface is visible to the moment the goal is reached. Typing into a field is one action regardless of length. Navigation into the surface is not counted.

A budget above one requires a stated reason: an irreversible outcome, a genuinely independent second intent, or a value the product cannot resolve.

## Immediate Feedback

Every action reports progress on the control that was activated, within the same frame it was activated. Progress never replaces the surrounding content and never blocks unrelated controls.

Local, reversible changes apply optimistically. A failure restores the previous value and explains itself next to the control that failed, not only in a toast.

Duplicate submission is prevented by the control's own busy state rather than by disabling the region around it.

## Remembered Input

A choice the user has already made is the default the next time the same action runs, as long as it is still valid. This applies to selected models, active filters, expanded rows, and chosen categories.

Remembered input is applied silently. Do not present it as a step to confirm.

## Changelog

### 2026-09-19

- Established the interaction contract: single activation point per goal, server-observable staleness recovered without a manual control, declared per-page action budgets, control-local immediate feedback, and silently reapplied remembered input.
