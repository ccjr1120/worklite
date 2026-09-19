# Shared States

## Loading and Mutation

Keep the shell stable. Use content-shaped skeletons instead of ordinary full-page spinners. Show progress locally for local mutations and prevent duplicate submissions without hiding context.

A skeleton stands in for the content it replaces. Do not render the frame of absent content beside it: a table header above no rows, or a detail heading above no fields, reports structure the surface cannot yet fill.

The router owns the shell-level pending and error boundaries. A route that has not resolved shows a content-shaped skeleton inside the stable shell, and a route that throws shows a recoverable failure with a retry that invalidates the router. A page defines only the states it adds beyond those defaults.

Every state on this page is reachable in every route context. A detail route resolves loading, not-found, and load failure as three distinct states; presenting a pending fetch as a missing object misreports it.

Local mutations apply optimistically where the change is reversible. A failure restores the previous value and explains itself beside the control that failed. `interaction-contract.md` governs which actions must behave this way.

Use one destructive confirmation pattern for permanent removal: name the object, state the consequence, keep Cancel as the lower-emphasis action, use destructive styling only for the confirmed action, prevent duplicate submission, and retain the failure in the dialog until recovery or dismissal. Cancellation of work is not destructive: present it as a neutral secondary execution control with a text or icon cue and a distinct busy state.

## Empty and No Results

An empty collection explains the object and provides one authorized next action. No-results state names the active filtering and offers `Clear filters`. Do not use large generic AI illustrations.

These are two states, not one. A collection with nothing in it must not be described as having no matches, and must not offer to clear filters that are not set. Branch on whether the unfiltered collection is empty, not on whether the filtered result is.

A placeholder value such as an em-dash is acceptable for a genuinely absent field. It is not acceptable as the permanent content of a column that has no data source; remove the column instead.

## Error and Permission

Explain failures in user terms, preserve unaffected content, and provide recovery. Durable errors remain in the page rather than only in a toast. Resource errors identify the unavailable item or action without leaking protected details. Agent turns render credential-safe failure reasons and explicit cancellation cues inline; raw provider or SDK errors and malformed tool input are never presentation content.

## Offline and Streaming

Use a restrained persistent reconnecting bar. Explain whether edits are local, blocked or persisted. Resume run events without duplication. Streaming content preserves scroll position unless the user is following the end. Create the destination response region as soon as a turn starts, retain partial content on failure, and expose a non-color streaming, cancellation, or failure cue without announcing every token to assistive technology. Agent composer drafts remain editable during an active turn but are not queued; Send becomes Stop until the current turn completes or is cancelled.

Human-gated execution is durable. A `Waiting for input` Run keeps its pending action visible across navigation and reload, exposes expiry and recovery controls, and resumes automatically when the server observes completion. QR expiry is a recoverable pending state rather than a failed Run.

A failed Run is recoverable at the node the server marks as retryable. Retry is a neutral execution control local to that node entry, not a destructive action and not a Run-level rerun. It reports progress on the control itself, preserves the existing failure reason until execution continues, and surfaces a rejected retry beside that reason rather than replacing it.

## Truthful Feedback

Success feedback reports an outcome that occurred. A control must not confirm work it did not perform, and a toast must not substitute for the action itself. When a capability is unavailable for the current object, the control is absent rather than present and inert.

## Long Content and Security

Truncate only summaries and provide expand, copy, download or details access. Inline Agent Skill calls stay collapsed by default, retain status and exit context in their summary, and reveal height-bounded scrollable raw output only on request. Never reveal secrets in fields, logs, errors or audit metadata. Untrusted content is rendered without inline execution.

## Changelog

### 2026-09-19

- Assigned the shell-level pending and error boundaries to the router so every route inherits a content-shaped skeleton and a recoverable failure.
- Required detail routes to distinguish loading, not-found, and load failure instead of presenting a pending fetch as a missing object.
- Prohibited rendering the frame of absent content beside a skeleton, and required optimistic application with rollback for reversible local mutations.
- Required empty and no-results to branch on the unfiltered collection, and prohibited permanent placeholder columns with no data source.
- Added Truthful Feedback: success confirms work that occurred, and an unavailable capability omits its control rather than presenting it inert.

### 2026-09-18

- Added node-scoped failed-Run recovery: a neutral retry control on the server-marked retryable node entry, with control-local progress and preserved failure reasons.

### 2026-09-16

- Added durable human-gated Workflow waiting, QR expiry, refresh, and automatic continuation states.

### 2026-09-14

- Standardized destructive confirmation structure and reclassified execution cancellation as neutral, non-destructive feedback.

### 2026-08-27

- Required inline credential-safe Agent failure reasons and explicit cancellation cues without exposing malformed tool input or raw provider and SDK errors.
- Defined collapsed-by-default Agent Skill-call summaries and bounded on-demand output for long transcript content.
- Replaced obsolete local Agent message queue guidance with editable, unqueued drafts, transcript-owned working feedback, and active-turn Stop behavior.

### 2026-08-26

- Added queued-message visibility, removal, and failure-pause behavior to shared streaming states.

### 2026-08-26

- Defined incremental response placement, partial-content retention, conditional auto-follow, and restrained live announcements for model streams.

### 2026-08-13

- Extracted shared loading, empty, error, permission, offline, streaming and long-content rules.
