# Shared States

## Loading and Mutation

Keep the shell stable. Use content-shaped skeletons instead of ordinary full-page spinners. Show progress locally for local mutations and prevent duplicate submissions without hiding context.

Use one destructive confirmation pattern for permanent removal: name the object, state the consequence, keep Cancel as the lower-emphasis action, use destructive styling only for the confirmed action, prevent duplicate submission, and retain the failure in the dialog until recovery or dismissal. Cancellation of work is not destructive: present it as a neutral secondary execution control with a text or icon cue and a distinct busy state.

## Empty and No Results

An empty collection explains the object and provides one authorized next action. No-results state names the active filtering and offers `Clear filters`. Do not use large generic AI illustrations.

## Error and Permission

Explain failures in user terms, preserve unaffected content, and provide recovery. Durable errors remain in the page rather than only in a toast. Resource errors identify the unavailable item or action without leaking protected details. Agent turns render credential-safe failure reasons and explicit cancellation cues inline; raw provider or SDK errors and malformed tool input are never presentation content.

## Offline and Streaming

Use a restrained persistent reconnecting bar. Explain whether edits are local, blocked or persisted. Resume run events without duplication. Streaming content preserves scroll position unless the user is following the end. Create the destination response region as soon as a turn starts, retain partial content on failure, and expose a non-color streaming, cancellation, or failure cue without announcing every token to assistive technology. Agent composer drafts remain editable during an active turn but are not queued; Send becomes Stop until the current turn completes or is cancelled.

Human-gated execution is durable. A `Waiting for input` Run keeps its pending action visible across navigation and reload, exposes expiry and recovery controls, and resumes automatically when the server observes completion. QR expiry is a recoverable pending state rather than a failed Run.

## Long Content and Security

Truncate only summaries and provide expand, copy, download or details access. Inline Agent Skill calls stay collapsed by default, retain status and exit context in their summary, and reveal height-bounded scrollable raw output only on request. Never reveal secrets in fields, logs, errors or audit metadata. Untrusted content is rendered without inline execution.

## Changelog

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
