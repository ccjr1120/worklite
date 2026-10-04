# Feishu master conversation

## Route

The configured Feishu application's private conversation. This is one channel of Chat. Configuration lives in `/chat` under Channels.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/api/src/modules/plugins/feishu/feishu.service.ts`
- `apps/api/src/modules/plugins/feishu/feishu-cards.ts`
- `apps/web/src/features/plugins/plugin-configuration.tsx`
- `apps/web/src/features/chat/records.tsx`
- `apps/web/src/features/chat/channel-configuration.tsx`

## Purpose

Converse with the master Agent and run Team or published Workflow tasks from Feishu.

## Primary Task

Send one request, action budget one — sending text to Chat. Ordinary conversation receives a natural reply. The master dispatches a clear Team or published Workflow request through the existing platform scripts. Only a material unresolved choice or missing information adds an answer action; a plan is not required to ask. Choices belong to this request and never select a mode for future messages. Exact-command authorization requires its own task-bound form submission.

## Layout

One updated card per accepted submission, using Feishu’s native layout and theme in light and dark modes. Dialogue cards have no header, mode footer, resource menu or successful-completion label. A restrained text status precedes the reply only while queued, thinking, responding, processing, waiting, failed or cancelled. Question options use native neutral buttons; with options, free-text answers use ordinary chat rather than an additional form. Questions without options retain an answer form. Task cards show executor progress and question controls. Files are separate native file messages. Web configuration uses shared Field, Input, Button and status semantics in both themes.

## Interaction Contract

- Message: persist the receipt and ordinary reply placeholder atomically before acknowledging; show queued state before dispatch, retain it behind an active master turn, and replace its content with progress and the final reply. Do not echo the user’s message as loading content.
- Choice: display only options supplied by the master’s current pending question. Clicking answers that bound question and resumes the current request; direct text is also accepted. Clear obsolete controls after answering. No persistent target switching.
- Progress: show `正在思考…` before model text, `正在回复…` during streamed text, and `正在处理…` during tools. Replace progress with the final reply. Preserve partial text and a safe reason on failure or cancellation; expose only applicable recovery and execution controls.
- Task answer: reply to the task card or submit its input; the server verifies its bound pending question and scope.
- Command: the user enters each complete command on its own line and submits the current question form once. Only those exact submitted strings grant permission; prose and model scripts cannot manufacture Feishu grants.
- Controls: pause, resume, cancel, recovery and retry address the card's task reference and reuse existing domain APIs.
- Delivery: use committed domain documents and Artifacts; resend after failure without regenerating them.
- Freshness: server snapshots, persisted submissions and a delivery worker keep cards current after reconnect. No manual refresh control.
- Upgrade: one server-bound card shows the immutable release, requested changes and authorized lifecycle operations. One “升级到此版本” action authorizes that release. Persist progress and show success, preflight failure or restored previous release in that same conversation after reconnect. Model prose cannot confirm it.
- Capabilities: a requested extension or selected capability is persisted separately from built-in knowledge; the reply identifies the saved revision and that it applies from the next turn.

## States

| State | Behavior |
| --- | --- |
| Loading | The persisted response placeholder shows `已排队` before dispatch, then `正在思考…`; the same card becomes the reply. |
| Empty | First text opens a master conversation. |
| No results | No idle resource menu exists. The master describes an unavailable requested capability in dialogue. |
| Error | Show a credential-safe reason and task-bound recovery. |
| Busy | Update one card with partial reply and concise progress. Show pending-choice buttons only while that question is active; successful ordinary replies retain only their content. |
| Offline | Retain inbound submissions and delivery state for reconnect. |
| Upgrade | Show awaiting confirmation, preflight, handoff, switching, recovery and final outcome; cutover may briefly disconnect. |
| Long content | Send the complete result as a native file when it exceeds the card content threshold; show a state message while a long reply is generating. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `plugins:feishu.appId` / `appSecret` / `allowedUserId` | Constraint |
| `plugins:feishu.secretConfigured` | State |
| `plugins:feishu.status.*` | State |
| `plugins:feishu.disconnect` | Action |
| Native card question options / answer / control / command / delivery labels | Action |
| `已排队` / `正在思考…` / `正在回复…` / `正在处理…` / waiting, failure and cancellation labels; task completion labels | State |
| Native card operation failure reason | Recovery |
| `升级到此版本` | Action |
| Upgrade version / progress / result | State |

## Accessibility

Use native text labels for every card action and status. Input labels are explicit. Do not rely on color, icons or hover alone. Web form fields retain keyboard focus while status updates.

## Coverage Status

Source comparison: 2026-10-04. Web Chat can inspect and continue Feishu executions. Future inbound receipts retain safe original message and callback context; card send/update and file send receipts include complete content, platform result, identifiers and delivery failures. The records view preserves partial streamed text and supports a full JSON download. Older fields that were never persisted cannot be recovered. The adapter implements private text intake, persisted event receipts, per-submission task bindings, incremental dialogue cards, task-bound questions and execution controls, Workflow QR images, and native files for committed Team documents and Workflow Artifacts. Closed dialogue cards use their own message and event boundaries. Model dispatches reuse the same server boundary and are attached to their originating Feishu conversation.

Upgrade cards now render the bound release, change summary, enumerated authorized operations, one confirmation action and persisted outcome. User configuration extensions and per-turn capability snapshots are implemented through protected platform scripts. These additions have not been exercised in a running service or Feishu client.

This change removes fixed mode menus, adds current-question options and concise dialogue loading, and retains the existing task controls. Previously saved targets no longer route new messages. These changes have not been verified with a type check, runtime or Feishu client.

Platform rendering, granted permissions, live connection behavior and keyboard/screen-reader behavior remain unverified; no runtime or platform verification was authorized. Inbound images, voice, files and group messages are outside the implemented scope. Web configuration now uses a loading skeleton and local retry. Request-error placement and unrelated plugin differences remain recorded in its page specification.

## Changelog

### 2026-10-04

- Moved channel configuration into Chat and exposed complete persisted ingress, execution and delivery evidence in the Web workspace.

- Made ordinary dialogue the permanent message entry, with current-request questions and options instead of fixed mode menus.
- Defined queued placeholders, concise loading in the same card, unframed successful replies, and retained partial replies on failure.

- Added release confirmation and upgrade progress with notification after reconnect; capability updates identify the saved revision and next-turn effect.
- Defined and implemented the approved private-chat master-Agent surface and task-bound interaction contract; recorded source coverage without claiming platform verification.
