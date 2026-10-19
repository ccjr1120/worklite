# WeChat master conversation

## Route

The logged-in iLink bot's private WeChat conversation. This is one channel of Chat. Configuration lives in `/chat` under Channels (`/chat?view=channels`).

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/api/src/modules/plugins/wechat/wechat.service.ts`
- `apps/api/src/modules/plugins/wechat/ilink.ts`
- `apps/web/src/features/plugins/plugin-configuration.tsx`
- `apps/web/src/features/chat/channel-configuration.tsx`
- `apps/web/src/features/chat/records.tsx`

## Purpose

Converse with the master Agent from WeChat private messages without opening the Web workspace.

## Primary Task

Send one text message, action budget one — sending text to Chat. Ordinary conversation receives one whole text reply per accepted message. A pending conversation question is answered by replying with ordinary text; an operation-recovery question is answered with the exact texts 「采用已有命令结果」 or 「标记操作失败」, and a failed conversation is restarted by sending 「新对话」. Team and Workflow tasks dispatched from WeChat report status by plain-text notification; their questions and actions stay on their own Web surfaces.

## Layout

Web configuration uses shared Field, Input, Button and status semantics in both themes: one QR login card showing the login QR image with a cancel control while a login is open, one allowed-user field, one connection status badge, and one disconnect control while connected. In WeChat itself, every server message is an ordinary private-chat text message; there are no cards, buttons, streams or edits.

## Interaction Contract

- Login: starting QR login is the single activation. The scanning user is bound as the one allowed user automatically; an expired QR is refreshed by the server up to twice inside one login session before the login expires and must be restarted explicitly. A stale login (platform token expiry) sets the connection status to error and requires a fresh QR scan; no credential is ever displayed.
- Access control: only the bound allowed user's private messages are received; group messages and other senders are ignored without reply.
- Message: persist the receipt and reply placeholder atomically before dispatch; the user receives one fixed acknowledgement `已收到，正在处理…` only when acceptance itself is the first deliverable state.
- Reply: deliver whole text replies on terminal state only — no streaming typewriter, no message edits. Long replies are truncated at a fixed byte budget with a pointer to WorkLite for the full content.
- Choice: a pending conversation question is delivered as text with numbered options; any text answer resumes the bound question. Recovery questions accept only their exact decision texts.
- Tasks: Team and Workflow dispatches send one text notification per status change (started, waiting for input, terminal). Their pending questions are not answerable from WeChat and point to WorkLite.
- Freshness: inbound long-poll resumes from the persisted sync cursor after reconnect or restart; redelivered messages are deduplicated by their platform message id. Outbound deliveries resume from persisted submissions. No manual refresh control.
- Upgrade: adapter writes freeze with the runtime during a managed upgrade and the connection resumes after completion; in-flight sends are retried from persisted state.

## States

| State | Behavior |
| --- | --- |
| Loading | The login card shows a status line while the QR is requested, pending or scanned. |
| Empty | Before first login, the section shows one QR login action and no connection state. |
| No results | Not applicable; there is no collection on this surface. |
| Error | Login failure, expired QR and stale token show a credential-safe reason with one restart action; delivery failure retains the submission for automatic retry. |
| Busy | While a submission runs, no further WeChat messages are sent until a question, task status change or terminal reply occurs. |
| Offline | After reconnect the monitor resumes from the persisted sync cursor; unprocessed receipts and unsettled deliveries continue automatically. |
| Upgrade | Runtime admission closes for new logins during freeze; the connection is re-established by the upgrade completion path. |
| Long content | Replies beyond the text budget are truncated with `……（内容过长已截断，完整内容请在 WorkLite 查看）`. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `plugins:wechat.title` / `description` | Constraint |
| `plugins:wechat.login` / `relogin` / `cancel` / `disconnect` | Action |
| `plugins:wechat.status.*` | State |
| `plugins:wechat.loginStatus.*` | State |
| `plugins:wechat.allowedUserId` / `allowedUserIdHint` | Constraint |
| `plugins:wechat.loginFailed` / `cancelFailed` / `disconnectFailed` / `qrFailed` | Recovery |
| `assistant:channels.wechatBound` / `wechatUnbound` / `wechatDisconnected` | State |
| `已收到，正在处理…` | State |
| `请求失败：…` / `对话失败：…` / `本轮对话已取消。` / `本轮对话已结束。` | State |
| Question text, numbered options and answer hints (`请直接回复你的答案。` etc.) | Action |
| `【Agent Team】…` / `【工作流】…` / `【WorkLite 部署】…` status notifications | State |
| `请前往 WorkLite 处理该问题。` | Recovery |
| Truncation note | Constraint |

## Accessibility

Web configuration uses native labelled inputs, explicit button text and `aria-live` status lines; the QR image carries an alt label and its failure state is announced as text. WeChat-side text messages carry no visual-only cues.

## Coverage Status

2026-10-18 initial implementation: QR login (start, server-side status polling with up to two automatic QR refreshes, cancel, expiry), encrypted token persistence, allowed-user binding from the scanning user, private-text intake with platform message-id idempotency, dispatch through the shared channel-neutral external-chat binding, whole-reply terminal delivery with fingerprint dedupe and persisted retry, and reconnect from the persisted sync cursor. Package typechecks and the locale key check pass; lint and unit tests are recorded in the task report. Real iLink QR scanning, live message send/receive, long-poll timeout behavior and platform-side `client_id` idempotency were not exercised and remain unverified.

## Changelog

### 2026-10-18

- Added the WeChat channel surface: QR login, single allowed user, private text conversation with whole text replies, plain-text task status notifications, and reconnect recovery.
