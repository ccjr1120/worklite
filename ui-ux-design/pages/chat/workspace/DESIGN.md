# Chat workspace

## Route

`/chat`, with validated `view=conversation|channels|configuration` and optional `conversation` selection.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/web/src/routes/chat.tsx`
- `apps/web/src/features/chat/index.tsx`
- `apps/web/src/features/chat/conversation-list.tsx`
- `apps/web/src/features/chat/records.tsx`
- `apps/web/src/features/chat/channel-configuration.tsx`
- `apps/api/src/modules/agents/chat-conversations.service.ts`

## Purpose

Converse with the protected master Agent through Web, configure its capabilities and communication channels, and inspect complete stored conversations and execution evidence from every implemented channel.

## Primary Task

Send a request and read its response. Action budget one: submit the composer. A material pending question adds one answer action. Channel configuration is an independent goal: one activation for Feishu QR registration, or field input and one save for an existing application because credentials must come from the operator. Inspecting a saved conversation costs one selection; opening its complete record pane is one separate inspection action.

## Layout

A full-height workspace with a stable top context bar and lightweight Conversation, Channels and Configuration tabs. Conversation places a compact searchable, channel-filtered server conversation list on the left and an unframed transcript with composer on the right. The complete evidence pane opens below the conversation header and scrolls within its own region; ordinary replies stay readable. Below `md`, the conversation list opens in a labelled navigation drawer, preserving the full transcript width. Both themes use shared semantic tokens; ordinary icons and secondary actions stay neutral. Chat replaces Home's bottom composer and the shell floating Chat Bot.

Channels presents Web as the built-in channel and Feishu as the configured external adapter. Selecting Feishu exposes QR registration, manual credentials and connection status in the same page. Agent Configuration is independent and owns model selection, user prompt, Skills and MCP server selections. No create/delete Agent controls or future unimplemented channel controls appear.

## Interaction Contract

- Send and answer: use shared `POST /chat/dispatch`, stable submission ids and the existing master execution. `Enter` sends the composer and `Shift+Enter` inserts a newline; while an input method is composing text, `Enter` first confirms that composition instead of submitting it. Show an immediate response region; stream persisted Agent events. Keep partial replies on failure, with existing retry and cancellation controls. Show options only for the active pending question.
- History: cursor-page `GET /chat/conversations`, with server data as authority. Search and channel filters operate on server history. Browser memory remembers only the selected id; it never limits discovery. Selecting a conversation silently restores its in-memory draft and queue without cancelling another execution. Accepted queued requests carry stable submission ids, so returning after a response was interrupted cannot create another turn. Navigation retains browser-session drafts/queues in memory; reload clears unsent input.
- New conversation: one action opens an empty Web composer; the first accepted request creates its server execution. Existing records stay available.
- Feishu conversation: identify the bound channel before submission. Web can continue its Agent execution; the adapter projects replies into the same Feishu-bound conversation. Exact Team command grants still require the task-bound authoritative form and cannot originate from ordinary chat prose.
- Records: load the full execution snapshot, stored Agent events, inbound and outbound receipts, selected actions/forms, submissions, rendered outbound cards, safe errors and delivery identifiers. Reveal raw saved fields only on deliberate disclosure. Provide full text copy/download; never truncate evidence or model-returned reply content. Related Team/Workflow tasks link to their authoritative detail routes.
- Freshness: execution SSE and five-second conversation/record queries recover observable changes automatically, retaining current content and reader scroll. No manual refresh control. Older history is explicitly paged, with no hidden final cap.
- Configuration: save at the activated control, keep durable request failures beside it, and retain immutable per-turn configuration snapshots. New turns use the latest revision; answers/retries retain their accepted snapshot.
- Channels: reuse the approved Feishu QR and manual setup interactions; the adapter owns identity, connection and platform-specific presentation. Web conversation needs no channel registration.
- Slash commands: retain `/new`, `/resume` and `/log` as shortcuts for visible page capabilities. History comes from the server. Escape dismisses inner menus and selections, without hiding the Chat page.

## States

| State | Behavior |
| --- | --- |
| Loading | List and transcript skeletons keep the shell and tabs stable; evidence and setup loading stay local. |
| Empty | Empty Web conversation shows the composer; no fixed capability or mode menu. A channel without records states it has no conversation yet. |
| No results | Name the active search/filter and offer clearing it. |
| Error | Preserve the selected transcript and show safe errors beside the affected send, configuration, channel or records action. |
| Busy | Keep draft editable, preserve existing FIFO queue behavior, show concise inline processing and local disabled/busy controls. |
| Offline | Retain current data, show reconnect state and resume existing streams without resubmitting requests. |
| Long content | Full message body wraps. Evidence uses bounded scrollable full text with copy/download. Only conversation titles/previews truncate. |
| Channel waiting | A received Feishu message awaiting an execution remains visible with receipt status; queued messages do not disappear because they have no execution yet. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `workspace:nav.chat` / `assistant:title` / `assistant:panelTabs.*` | State |
| `assistant:history.*` | Action, State or Recovery according to individual key |
| `assistant:channels.*` | Action, State or Constraint according to individual key |
| `assistant:records.*` | Action, State or Constraint according to individual key |
| `assistant:composer.*` / `assistant:queue.*` / `assistant:execution.*` | Action, State or Recovery according to individual key |
| `assistant:configuration.*` | Action, State or Constraint according to individual key |
| `plugins:feishu.*` | Reused channel Action, State, Constraint or Recovery |

## Accessibility

Tabs use ArrowLeft/ArrowRight, Home/End and visible focus. Label session search, channel filters, input fields and icon controls. Use textual channel, execution and delivery status. Preserve focus during streaming and channel polling. Conversation uses the shared return-to-end control; new messages never pull a reader away from earlier content. Respect reduced motion, and use restrained status/alert announcements.

## Coverage Status

Source comparison also covers generation guards for switched conversations, retained cached history on read failures, local load retry, complete execution export and explicit current Feishu delivery availability. This source comparison ran no automated checks; deployment compilation and isolated readiness were subsequently authorized and passed as recorded below.

Source comparison 2026-10-04: the old embedded surface supports persisted messages, SSE, Skill/MCP activity, questions, retry, cancellation, Workflow mentions, queues and exports. The new source adds the full-page route and server conversation list, removes the silent browser history cap, places Feishu under Channels, exposes complete saved channel/Agent records and retains failed streamed text in the read model. The embedded surface and its fixed starter menu have been removed. Source coverage also includes standalone Web task submissions that have no Agent execution. The later deployment request authorized Gateway/Web/API compilation and isolated Web/API/Gateway readiness; these passed on 2026-10-04. Browser rendering, standalone type checking, test suites and live Feishu checks were not performed. Historical original Feishu envelopes were not saved and cannot be recovered; records show full retained data and newly saved safe platform context.

## Changelog

### 2026-10-05

- Required `Enter` to confirm in-progress IME composition before it can send the Chat composer; `Shift+Enter` remains a newline.

### 2026-10-04

- Replaced the embedded Chat Bot with the Chat workspace, direct Web channel, channel-independent Agent configuration, Feishu setup and complete server-persisted history/evidence.
