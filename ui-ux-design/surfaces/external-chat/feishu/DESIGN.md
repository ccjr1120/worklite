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

Send one request, action budget one — sending text to Chat. Ordinary conversation receives a natural reply. The master dispatches a clear Team or published Workflow request through the existing platform scripts. For Team work, it collects the absolute project directory and supported mode before creating a Run; a busy Team rejects dispatch. Only a material unresolved choice or missing information adds an answer action; a plan is not required to ask. Choices belong to this request and never select a mode for future messages. Exact-command authorization requires its own task-bound form submission.

## Layout

One reply card per accepted submission plus one task card per project task dispatched in that turn, using Feishu’s native layout and theme in light and dark modes. Content is split across cards instead of clustered into one: the reply card carries status, streamed reply, pending question and conversation controls; each task card carries that task's executor, model, stage, status, latest progress text, an item-by-item list of recent activities with their total count, the task's own pending-question form and its cancel control. Dialogue cards have no header, mode footer, resource menu or successful-completion label. A separate native text status precedes the reply only while queued, thinking, responding, processing, waiting, failed or cancelled. Active progress pairs a neutral native loading icon with its text; the icon is not assumed to rotate. Model replies use the native fast typewriter display on the reply card only; task cards update without streaming. Team and Workflow execution details use a default-collapsed native panel, while the current task/step, outcome, failures, questions, QR images and controls remain visible. A Team task card's status line carries the Run's current phase and server-derived completion percentage (for example `正在执行 · 开发 2/4`), and each task row inside details keeps its latest public progress text. Question options use native neutral buttons; with options, free-text answers use ordinary chat rather than an additional form. Questions without options retain an answer form. Task cards show executor progress and question controls. Files are separate native file messages. Web configuration uses shared Field, Input, Button and status semantics in both themes.

## Interaction Contract

Chat Codex and Team developer share direct execution without WorkLite proposal or exact-command approval. Their questions collect material missing information and omit command-grant fields. Chat only orchestrates protected platform operations, Codex tasks, Team Run dispatch and published Workflows. Non-Codex Team roles retain their authorization controls.

- New conversation intent: Chat asks a typed pending question after recognizing the user's request and shows one contextual “新对话” button. Clicking creates and selects the new persisted conversation; old history and task evidence remain. This action is absent from ordinary replies and disappears after acceptance. No permanent reply menu or text-command requirement is introduced.

- Retired command question: a never-started Shell call waiting on removed per-command authorization is cancelled by the server, retaining its history and clearing the invalid question. The server persists the resulting snapshot for replay; later messages return to normal dialogue with no manual stop instruction or extra recovery button is required. Reserved effects still use explicit recovery.
- Execution boundary: coding, repository investigation and local command tasks delegate directly to Codex; collaborative work uses Team Run dispatch and automation uses published Workflows. Chat has no direct host tools or custom Skill/MCP execution. Historical Shell evidence and explicit uncertain-effect recovery remain inspectable without starting another Command. This rule is shared by Web and Feishu.
- Independent Codex task: keep progress, result and full execution evidence in the originating conversation. Reuse the existing tool disclosure and answer region. Codex starts from the clear user request without WorkLite proposal confirmation or a command form. An uncertain operation offers adopt-existing-result or mark-failed, without automatic replay. Stop cancels the task; uncertainty retains a visible recovery question. Ordinary dialogue and both themes retain their existing layout.

- Message: persist the receipt and ordinary reply placeholder atomically before acknowledging; show queued state before dispatch, retain it behind an active master turn, and replace its content with progress and the final reply. Do not echo the user’s message as loading content.
- Choice: display only options supplied by the master’s current pending question. Clicking answers that bound question and resumes the current request; direct text is also accepted. Clear obsolete controls after answering. No persistent target switching.
- Rendering: use stable component ids and update status and reply independently. Structural changes replace the CardKit entity content. Close streaming before pending-question interaction, tool processing and terminal updates; renew it while model output continues past the platform window. Successful ordinary replies remove progress. The reply card and each task card are separate CardKit entities and messages: each task card is created lazily when its task first appears, keeps its own persisted transport, sequence and idempotency identity, and updates only when its fingerprint changes.
- Details: one native expansion reveals Team task attempts or Workflow node execution statuses; expansion is optional and adds no action to the primary task. Updating status or reply must not replace the detail panel.
- Progress: show `正在思考…` before model text, `正在回复…` during streamed text, and `正在处理…` during tools. Replace progress with the final reply. Preserve partial text and a safe reason on failure or cancellation; expose only applicable recovery and execution controls.
- Task answer: reply to the task card or submit its input; the server verifies its bound pending question and scope.
- Command: the user enters each complete command on its own line and submits the current question form once. Only those exact submitted strings grant permission; prose and model scripts cannot manufacture Feishu grants.
- Controls: pause, resume, cancel, recovery and retry address the card's task reference and reuse existing domain APIs.
- Delivery: use committed domain documents and Artifacts; resend after failure without regenerating them.
- Freshness: server snapshots, persisted submissions and a delivery worker keep cards current after reconnect. No manual refresh control.
- Upgrade: sending an explicit WorkLite redeploy request is the single activation and authorization. A server-bound task card shows the immutable release, requested changes and phase without a confirmation button. Persist progress and show success, preflight failure or restored previous release in that same conversation after reconnect. A proposal alone does not execute; a new redeploy request captures the current project. Model suggestions and historical requests are not authorization.
- Capabilities: a requested extension or selected capability is persisted separately from built-in knowledge; the reply identifies the saved revision and that it applies from the next turn.

## States

| State | Behavior |
| --- | --- |
| Historical Shell call | Retain stored command evidence and explicit recovery; no new direct Shell call can execute. |
| Codex task | Show task state and persisted Command references in the existing execution disclosure; the captured user task and any pending question or uncertain result remain visible and task-bound across reload. |
| Loading | The persisted response placeholder shows `已排队` before dispatch, then `正在思考…`; the same card becomes the reply. |
| Empty | First text opens a master conversation. |
| No results | No idle resource menu exists. The master describes an unavailable requested capability in dialogue. |
| Error | Show a credential-safe reason and task-bound recovery outside the collapsed panel; keep partial reply text and close streaming. |
| Busy | Update the reply card with native streamed reply text and a separate concise progress component; each active project task updates its own task card with stage, progress text and recent activities. Show pending-choice buttons only while that question is active; successful ordinary replies retain only their content. |
| Offline | Retain inbound submissions, CardKit identifiers and sequenced pending updates for reconnect; retry an unacknowledged pending UUID and payload before newer updates. A classified platform rejection is recorded and allows a new sequenced delivery, including reopening an expired stream. |
| Upgrade | Show a non-executing proposal, or authorized deployment with preflight, handoff, switching, recovery and final outcome; cutover may briefly disconnect. No confirmation control. |
| Long content | Send the complete result as a native file when it exceeds the card content threshold; show a state message while a long reply is generating. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `assistant:shell.command` / historical Shell evidence | Action or Constraint according to the label |
| `assistant:codex.adopt`, `assistant:codex.markFailed` / native recovery controls | Action, State, Constraint or Recovery according to the individual label |
| `plugins:feishu.appId` / `appSecret` / `allowedUserId` | Constraint |
| `plugins:feishu.secretConfigured` | State |
| `plugins:feishu.status.*` | State |
| `plugins:feishu.disconnect` | Action |
| Native card question options / answer / control / command / delivery labels | Action |
| `已排队` / `正在思考…` / `正在回复…` / `正在处理…` / waiting, failure and cancellation labels; task completion labels | State |
| Native card operation failure reason | Recovery |
| `执行详情` | Action |
| Task/step names and execution statuses inside details | State |
| Task card stage labels (`正在启动` / `正在执行` / `正在回复` / waiting and terminal labels) | State |
| Task card activity list items and activity count | State |
| `取消任务` on a task card | Action |
| Task card answer form labels (`回答` / `提交回答`) | Action |
| Run phase and completion percentage on Team task cards | State |
| `等待重新部署指令` / `部署已启动` / deployment phases and outcomes | State |
| Upgrade version / progress / result | State |

## Accessibility

Use native text labels for every card action and status. Input labels are explicit. Do not rely on color, icons or hover alone. Web form fields retain keyboard focus while status updates. Details use native keyboard-accessible expansion. Native text uses default theme-aware color; no fixed light/dark palettes or custom animation is added. Typewriter rendering is owned by the Feishu client; its reduced-motion behavior remains unverified, and all progress retains static text cues.

## Coverage Status

2026-10-12 multi-card display source change: one submission now renders one reply card plus one task card per dispatched project task; each task card shows executor, model, stage, status, latest progress text, an item-by-item recent-activity list with total count, the task's pending-question form and cancel control, and persists its own CardKit transport. Full activity history beyond the recent window stays Web-only. No runtime, Feishu client, type check, test, build or deployment was performed.

2026-10-08 authorized deployment of Chat-requested redeployment: `pnpm deploy:local` incremented the public version from 0.1.3 to 0.1.4. Gateway/Web builds, API compilation during isolated startup, preflight on ports 23490–23492 and target readiness on ports 23390–23392 passed before replacement completed. This uses the ordinary local deployment entry and does not initialize a managed baseline. No Feishu client interaction, live Chat redeploy request, browser check, standalone type check or test suite was run.

2026-10-08 redeployment source change: the upgrade task card now displays the release, requested changes and persisted phase without an upgrade-confirmation button or callback. The protected redeploy operation binds the current user message; repeated calls in that turn return the same job. Existing native theme-aware text and task card layout are reused. Old confirmation cards have no compatibility action and require a new redeploy request. Runtime delivery, cutover/reconnect and Feishu client appearance remain unexercised; no type check, test, build, deployment or service operation was run. This entry supersedes the earlier upgrade-card coverage statement requiring a confirmation action.

2026-10-08 authorized deployment of the orchestration and event-loop correction: pnpm deploy:local incremented the public version to 0.1.2. Gateway and Web builds, isolated Web/API/Gateway preflight on ports 23490–23492 and deployment readiness on ports 23390–23392 passed before replacement completed. No browser interaction, live Codex delegation, Feishu integration or test suite was run.

2026-10-08 orchestration boundary: source inspection confirms the shared Chat runtime exposes only protected platform scripts, Codex delegation, planning and questions. Direct host tools and custom Skill/MCP execution are unavailable on both channels; historical effects retain explicit recovery. No Feishu integration, browser check, type check, test, build or restart was authorized or performed.

2026-10-08 authorized deployment: Gateway and Web builds, API compilation, isolated startup on ports 23490–23492 and deployment readiness on ports 23390–23392 passed through pnpm deploy:local. The deployment platform snapshot reports shared direct Chat/Team Codex execution without WorkLite grants and Chat cancellation in running/waiting states. The original conversation remains cancelled with no pending question. Browser appearance, real Codex task execution, live cancellation interaction and Feishu client behavior were not tested; no test suite or standalone type check was run.

2026-10-08 source comparison: Codex task questions retain ordinary answers and uncertainty recovery without command-grant forms; Team developer cards omit the command input. Feishu client and runtime checks were not authorized or performed.

2026-10-07 deployment-log recovery: conversation aex_febcb394-2460-4fe0-a163-96562b8084fb retained an obsolete Shell question without a Command reservation, causing Feishu new-conversation and follow-up messages to be rejected. Startup retirement now cancels the never-started call and clears pending input. Agent initialization persists the current cancellation snapshot for replay when the previous snapshot is stale. Authorized compilation, isolated preflight and deployment readiness passed. The requested online records confirm both current state and latest snapshot (sequence 145) are cancelled with no pending question, the Command id remains null, and the saved originating Feishu card has no old question or actions. New dialogue execution and client appearance were not tested.


2026-10-07 task-confirmation source comparison: Chat command fields and their obsolete copy were removed, and ask_user action confirm_execution renders the existing confirm/decline options. A bound affirmative answer persists the current proposal approval; direct Shell records its reference and Chat Codex captures the proposal. New ordinary user turns clear approval. Team forms retain exact-command grants. Shared semantic Web controls and native Feishu choices preserve both theme behaviors. Authorized deployment builds, API compilation, isolated startup preflight and Web/API/Gateway readiness passed. Live proposal confirmation, Shell/Codex execution, interrupted recovery and client appearance remain unverified; no standalone type check or tests were run.


2026-10-07 direct Shell source comparison: Chat exposes bash directly with a persisted call grant and atomic Command reservation, reuses current Web and native Feishu command forms, supports one complete multiline command, and exposes command/directory/output/exit evidence through existing disclosures. Shared semantic surfaces and native controls preserve light and dark mode behavior. Authorized deployment builds, API compilation, isolated startup preflight and Web/API/Gateway readiness passed. Real Shell execution, cancellation/restart recovery, browser appearance and Feishu client interaction remain unverified; no standalone type check or tests were run.

2026-10-07 source comparison: Chat owns persisted Codex tasks and journals outside Team, exposes captured task evidence in the existing tool disclosure, and uses structured exact-command forms and explicit uncertain-result recovery. The typed new-conversation question renders a button only for that intent; acceptance atomically settles the old question and creates the new conversation, retaining old history and task evidence. Feishu binds new ordinary messages to the new execution while old task deliveries keep their originating conversation. Neutral shared surfaces and native Feishu components retain both theme behaviors. Authorized Gateway/Web builds, API compilation, isolated startup preflight and deployment Web/API/Gateway readiness passed; deployment capability metadata exposes both increments. Browser appearance, keyboard behavior, live Codex task execution and Feishu client interaction remain unverified. No standalone type check or tests were run.

2026-10-06 implementation scope: CardKit entities and native streaming replace whole-message patches, stable status/reply components update locally, and task-attempt/node-run statuses appear in a native collapsed panel. Identifiers, ordered pending update payloads and delivery snapshots are persisted inside existing submission JSON. The user-authorized `pnpm deploy:local` passed Gateway/Web builds, API compilation, isolated startup preflight and Web/API/Gateway readiness after deployment replacement. No tests or live Feishu card checks were run. Runtime rendering, native keyboard/reduced-motion behavior, permissions, reconnect replay and Feishu client acceptance remain unverified. Existing message cards are intentionally not converted. The source comparison below records the earlier implementation and is retained as historical coverage.

Source comparison: 2026-10-04. Web Chat can inspect and continue Feishu executions. Future inbound receipts retain safe original message and callback context; card send/update and file send receipts include complete content, platform result, identifiers and delivery failures. The records view preserves partial streamed text and supports a full JSON download. Older fields that were never persisted cannot be recovered. The adapter implements private text intake, persisted event receipts, per-submission task bindings, incremental dialogue cards, task-bound questions and execution controls, Workflow QR images, and native files for committed Team documents and Workflow Artifacts. Closed dialogue cards use their own message and event boundaries. Model dispatches reuse the same server boundary and are attached to their originating Feishu conversation.

Upgrade cards now render the bound release, change summary, enumerated authorized operations, one confirmation action and persisted outcome. User configuration extensions and per-turn capability snapshots are implemented through protected platform scripts. These additions have not been exercised in a running service or Feishu client.

This change removes fixed mode menus, adds current-question options and concise dialogue loading, and retains the existing task controls. Previously saved targets no longer route new messages. These changes have not been verified with a type check, runtime or Feishu client.

Platform rendering, granted permissions, live connection behavior and keyboard/screen-reader behavior remain unverified; no runtime or platform verification was authorized. Inbound images, voice, files and group messages are outside the implemented scope. Web configuration now uses a loading skeleton and local retry. Request-error placement and unrelated plugin differences remain recorded in its page specification.

## Changelog

### 2026-10-13

- Team task references now bind directly to Run ids. Team has no conversation or intake; Chat Agent collects parameters and dispatches Runs. Run detail owns questions, command grants, documents and recovery, and returns to work records. No manual Team launch entry remains.


### 2026-10-12

- Split each submission's display into one reply card plus one task card per project task, with per-card persisted transports, fingerprint-gated updates, task-bound answer forms and cancel controls, and web-parity executor progress fields.

### 2026-10-10

- Added the Run's current phase and server-derived completion percentage to Team task card status lines and per-task progress text inside the details panel.

### 2026-10-07

- Added one request-bound new-conversation button after Agent intent recognition; accepting it preserves prior history and task evidence.
- Added conversation-owned Codex task evidence, exact-command answers and explicit uncertain-effect recovery using existing neutral interaction surfaces.

### 2026-10-06

- Added native fast typewriter replies, separate neutral status cues, component-local updates and default-collapsed task execution details.
- Kept questions, failures, authorization, QR and recovery visible, with the existing action budget and clean final replies.

### 2026-10-04

- Moved channel configuration into Chat and exposed complete persisted ingress, execution and delivery evidence in the Web workspace.

- Made ordinary dialogue the permanent message entry, with current-request questions and options instead of fixed mode menus.
- Defined queued placeholders, concise loading in the same card, unframed successful replies, and retained partial replies on failure.

- Added release confirmation and upgrade progress with notification after reconnect; capability updates identify the saved revision and next-turn effect.
- Defined and implemented the approved private-chat master-Agent surface and task-bound interaction contract; recorded source coverage without claiming platform verification.
