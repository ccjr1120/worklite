# Shared States

## Loading and Mutation

Keep the shell stable. Use content-shaped skeletons instead of ordinary full-page spinners. Show progress locally for local mutations and prevent duplicate submissions without hiding context.

## Empty and No Results

An empty collection explains the object and provides one authorized next action. No-results state names the active filtering and offers `Clear filters`. Do not use large generic AI illustrations.

## Error and Permission

Explain failures in user terms, preserve unaffected content, and provide recovery. Durable errors remain in the page rather than only in a toast. Permission states identify the unavailable resource or action and preserve team context without leaking protected details.

## Offline and Streaming

Use a restrained persistent reconnecting bar. Explain whether edits are local, blocked or persisted. Resume run events without duplication. Streaming content preserves scroll position unless the user is following the end.

## Long Content and Security

Truncate only summaries and provide expand, copy, download or details access. Never reveal secrets in fields, logs, errors or audit metadata. Untrusted content is rendered without inline execution.

## Changelog

### 2026-08-13

- Extracted shared loading, empty, error, permission, offline, streaming and long-content rules.
