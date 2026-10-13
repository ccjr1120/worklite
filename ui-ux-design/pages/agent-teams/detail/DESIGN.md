# Agent Team Detail

## Route

`/agent-teams/:teamId?tab=conversation|configuration`

The first release has one built-in Team. The workspace shell and Chat Bot starter link directly to its detail route; there is no Team collection page or creation/deletion action. Conversation is the default tab and selected tab state belongs to validated route search.

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/responsive-behavior.md`

## Implementation

- `apps/web/src/routes/agent-teams/$teamId.tsx`
- `apps/web/src/features/agent-teams/team-detail.tsx`

## Purpose

Start software work through the Team-owned Coordinator conversation and keep role configuration available without making execution look like configuration setup.

## Primary Task

Start a scoped Team Run by sending a Coordinator task request. Action budget: one when goal, mode, and a valid remembered directory are already known. The developer uses the same direct Codex executor as Chat and incurs no WorkLite proposal confirmation or command-grant action. Developer clarification shows only its answer input; exact-command fields belong to non-Codex roles. Additional actions are charged only for values the server cannot infer: selecting or typing a directory, choosing an ambiguous mode, or answering a later durable question. Once required intake values exist, the server creates the Run without another Start control.

Saving Team configuration is a separate goal with one Save action. Editing configuration never silently saves.

## Layout

The page uses the full Workspace page width with a `1200px` maximum and two lightweight top tabs. The Conversation tab has a compact Team header, a chronological transcript with its own bounded scroll region, and a persistent composer at the bottom. Member messages are left-aligned and user messages right-aligned; speaker identity, alignment, and text cues distinguish speakers without colored message backgrounds. A new-task composer has a structured removable `@Coordinator` token inside the same bordered surface as its multiline input and Send control; pending answers omit the token because their destination is already known. The conversation uses its full width while no contextual Run, queued intake, recovery, or selected document needs an inspector. Pending intake options and Run questions render in the transcript beside their answers.

When active Run, queued intake, operation recovery, or a selected document needs supporting controls, the desktop transcript shares the page with a contextual inspector. Below `1024px`, the transcript and inspector stack. The document viewer becomes an overlay below `768px`. The active Run inspector card summarizes parallel progress: current phase, server-derived completion percentage, completed and total development assignments, active Developers, next step, and the number of pending questions. Pending questions beyond the earliest render as inspector panels with their own answer inputs. The Configuration tab keeps process metadata and one Save action above a compact list of six roles. Each role shows its provider-grouped model selector in the list row; its instructions, entry points, Skills, MCP servers, and tools are disclosed only when that role's advanced settings are expanded. The Developer role additionally shows its executor selector; runtime parallelism is decided by the Planner per Run and is not configured here. The role list and its controls stack at narrow widths.

## Interaction Contract

| Action | Trigger and behavior |
| --- | --- |
| Select tab | Conversation or Configuration updates validated route search and preserves the other tab's server-backed state. |
| Insert Coordinator mention | The structured token can be selected with keyboard or pointer, remains removable, and is submitted with the message. Selection alone sends nothing. |
| Send Coordinator request | One Send activation persists the request and starts durable intake. The control shows local progress; complete intake creates one Run automatically and appends Run state to this conversation. |
| Select recent directory | One option activation submits the actual persisted directory selection and answers the current directory question. |
| Enter directory | One text reply plus Send supplies an absolute local directory. Invalid input stays in the composer with a recovery message. |
| Select mode | One inline option activation resolves an ambiguous execution scope. |
| Answer pending question | A plain reply plus Send addresses the current pending input id and scope revision. |
| Open Run evidence | One status/action link opens `/agent-team-runs/:runId`; it does not mutate the Run. |
| Open delivered file | One filename activation opens the immutable revision in the contextual viewer without changing transcript focus. |
| Download file | One Download activation in the viewer exports the same immutable revision. |
| Pause, Resume, or Cancel | Each independent control uses local progress and the existing Run API. No control is duplicated in the transcript. |
| Retry failed task | Retry appears only when the active Run exposes a retryable task, uses local progress, and calls the existing Run API. When several assignments failed together, each control names its task key and Developer; any one triggers the same failure-barrier resume and successful sibling lanes never rerun. |
| Answer later pending question | Pending questions beyond the earliest each render an inspector panel with their own answer input and control-local progress; submitting answers exactly that pending input id. The composer continues to answer the earliest pending question. |
| Save Team configuration | The Configuration tab Save control shows local progress, is disabled while saving, replaces the Team cache on success, and preserves local edits on failure. |
| Edit a role field | Editing updates local configuration only and marks it unsaved. Role executors are preserved across load and save. |
| Select model, Skills, MCP servers, or tools | Selection updates the role locally; Save is the sole commit control. |
| Expand role settings | One disclosure activation reveals that role's instructions, entry points, Skills, MCP servers, and tools. The disclosure is keyboard reachable and does not change saved configuration. |
| Select role model | The selector groups available models by Provider name and stores the selected public model id; the change remains local until Save. |
| Open from Chat Bot | The Team starter performs one navigation activation and does not send a Chat Bot message or dispatch a Team Run. |

Conversation and Run queries own freshness. The persisted conversation stream replays with `Last-Event-ID`, so no manual refresh control is introduced.

## States

| State | Behavior |
| --- | --- |
| Loading | Keep the page and composer geometry stable with content-shaped placeholders. |
| No task yet | Show an empty transcript state with `@Coordinator` selected by default in the composer; removing it is available for a message that should not start a Team task. No onboarding sequence is added. |
| Intake in progress | Show the unanswered Coordinator question, preserve prior answers and submitted requests across reload, and offer only actual recent directories. |
| Queued task request | A new Coordinator request remains visible as pending input while an active task has not settled. |
| Queued or running Run | Show the responsible member and concise state. Raw model deltas, task JSON, command output, and document bodies stay out of the transcript. The active Run card shows the current phase, completion percentage, assignment completion, active Developers, next step, and pending-question count. |
| Multiple pending questions | The composer answers the earliest pending question; the remaining questions render as inspector panels answered one by one. |
| Waiting for input | Show the durable question from the responsible member. A general reply cannot replace operation recovery. |
| Waiting for recovery | Show the existing structured adopt, fail, or replay decisions in the task context. |
| Paused | Preserve messages and files and expose Resume and Cancel. |
| File delivery failed | Show the delivery failure beside the document context; completed work and immutable document evidence remain readable. |
| Run failed or cancelled | Preserve completed files and state the reason. Retry appears only for the server-declared eligible task. |
| Completed | Preserve filenames and distinguish execution completion from unverified acceptance criteria. |
| Mutation failure | Keep the draft or selection and report the failure beside the activated control. |
| Load failure | Use the shared recoverable error state; durable conversation content remains absent only if the snapshot cannot load. |
| Offline or reconnecting | Retain durable messages, show a reconnecting state, and replay without duplicate messages or deliveries. |
| Long content | Wrap long paths and filenames, bound transcript scrolling, and open file bodies in an independently scrollable viewer. |

The Team query owns configuration freshness. No manual refresh control is introduced.

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:title` | State |
| `agentTeams:loading` | State |
| `agentTeams:loadFailed` | Recovery |
| `agentTeams:unavailable.title` | State |
| `agentTeams:unavailable.description` | Recovery |
| `agentTeams:conversation.tab` | Action |
| `agentTeams:configuration.tab` | Action |
| `agentTeams:conversation.title` | State |
| `agentTeams:conversation.empty` | Recovery |
| `agentTeams:conversation.loadFailed` | Recovery |
| `agentTeams:conversation.reconnecting` | State |
| `agentTeams:conversation.mention` | State |
| `agentTeams:conversation.removeMention` | Action |
| `agentTeams:conversation.inputPlaceholder` | Constraint |
| `agentTeams:conversation.enterDirectory` | Constraint |
| `agentTeams:conversation.invalidDirectory` | Recovery |
| `agentTeams:conversation.answerPlaceholder` | Constraint |
| `agentTeams:conversation.send` | Action |
| `agentTeams:conversation.sending` | State |
| `agentTeams:conversation.sendFailed` | Recovery |
| `agentTeams:conversation.returnToEnd` | Action |
| `agentTeams:conversation.run` | State |
| `agentTeams:conversation.queuedTask` | State |
| `agentTeams:conversation.queuedWaiting` | State |
| `agentTeams:conversation.project` | State |
| `agentTeams:conversation.openRun` | Action |
| `agentTeams:conversation.question.mode` | Constraint |
| `agentTeams:conversation.mode.*` | Action |
| `agentTeams:conversation.speaker.user` | State |
| `agentTeams:conversation.speaker.coordinator` | State |
| `agentTeams:conversation.speaker.member` | State |
| `agentTeams:conversation.speaker.system` | State |
| `agentTeams:conversation.fileDeliveryFailed` | Recovery |
| `agentTeams:conversation.document.title` | State |
| `agentTeams:conversation.document.loading` | State |
| `agentTeams:conversation.document.loadFailed` | Recovery |
| `agentTeams:conversation.document.revision` | State |
| `agentTeams:conversation.document.download` | Action |
| `agentTeams:conversation.document.downloading` | State |
| `agentTeams:conversation.document.downloadFailed` | Recovery |
| `agentTeams:conversation.document.close` | Action |
| `agentTeams:run.status.*` | State |
| `agentTeams:run.mode` | State |
| `agentTeams:input.commands` | Constraint |
| `agentTeams:run.commandsPlaceholder` | Constraint |
| `agentTeams:controls.failed` | Recovery |
| `agentTeams:controls.pause` | Action |
| `agentTeams:controls.pausing` | State |
| `agentTeams:controls.resume` | Action |
| `agentTeams:controls.resuming` | State |
| `agentTeams:controls.cancel` | Action |
| `agentTeams:controls.cancelling` | State |
| `agentTeams:controls.cancelTitle` | Constraint |
| `agentTeams:controls.cancelDescription` | Constraint |
| `agentTeams:controls.cancelConfirm` | Action |
| `agentTeams:tasks.retry` | Action |
| `agentTeams:tasks.retrying` | State |
| `agentTeams:tasks.retryTask` | Action |
| `agentTeams:progress.phase.*` | State |
| `agentTeams:progress.nextStep.*` | State |
| `agentTeams:progress.assignments` | State |
| `agentTeams:progress.percent` | State |
| `agentTeams:progress.activeDevelopers` | State |
| `agentTeams:progress.pendingQuestions` | State |
| `agentTeams:progress.waitingReason.*` | State |
| `agentTeams:recovery.title` | State |
| `agentTeams:recovery.decision` | Constraint |
| `agentTeams:recovery.adopt_command` | Action |
| `agentTeams:recovery.mark_failed` | Action |
| `agentTeams:recovery.replay` | Action |
| `agentTeams:recovery.submit` | Action |
| `agentTeams:recovery.submitting` | State |
| `agentTeams:recovery.failed` | Recovery |
| `agentTeams:team.updated` | State |
| `agentTeams:team.save` | Action |
| `agentTeams:team.saving` | State |
| `agentTeams:team.saveFailed` | Recovery |
| `agentTeams:team.process` | State |
| `agentTeams:team.processId` | State |
| `agentTeams:team.processVersion` | State |
| `agentTeams:team.roles` | State |
| `agentTeams:team.advanced` | Action |
| `agentTeams:model.default` | Action |
| `agentTeams:model.label` | Constraint |
| `agentTeams:team.executor.label` | Constraint |
| `agentTeams:team.executor.claude` | State |
| `agentTeams:team.executor.codex` | State |
| `agentTeams:instructions.label` | Constraint |
| `agentTeams:entryPoints.label` | Constraint |
| `agentTeams:entryPoints.placeholder` | Constraint |
| `agentTeams:skills.label` | Constraint |
| `agentTeams:skills.empty` | State |
| `agentTeams:mcpServers.label` | Constraint |
| `agentTeams:mcpServers.empty` | State |
| `agentTeams:tools.label` | Constraint |
| `agentTeams:role.*` | State |
| `agentTeams:resources.providers` | State |
| `agentTeams:resources.skills` | State |
| `agentTeams:resources.mcpServers` | State |
| `agentTeams:resources.loadFailed` | Recovery |
| `common:actions.cancel` | Action |

## Accessibility

The tabs, mention token, transcript, composer, role disclosures, provider-grouped model selectors, file link, viewer, download, and Run controls are keyboard reachable with visible shared focus rings. The selected `@Coordinator` token can be removed with its labelled control or Escape; model groups expose Provider labels to assistive technology. The transcript is a scrollable log-like region with accessible speaker labels; state changes use polite live regions while model deltas are not announced. File links expose their full accessible filename, the viewer retains a labelled close action, and SSE updates never move focus. Forms and option groups use visible labels, and all status text includes a non-color cue. Light and dark modes use the same neutral surfaces and semantic status tokens.

## Coverage Status

2026-10-10 source comparison for orchestration v3 and progress: the Developer role section carries only its executor selector (the extra-instance list and concurrency bound are removed because the Planner decides 1-4 parallel lanes per Run), and the active Run inspector card adds the server-derived completion percentage. No browser, runtime, accessibility-tool, type check or real-Run verification was authorized or performed.

2026-10-10 source comparison: the Developer role section carries an executor selector, up to three extra Developer instances with per-instance label, executor, model and advanced fields, and a 1–4 concurrency bound shown only when instances exist; load and save preserve executor, instances and concurrency. The active Run inspector card shows the progress summary, multiple pending questions gain their own answer panels, and multiple retryable failures list one retry control per task key with Developer attribution. Web type check (tsc --noEmit and locale key check) passed; no browser, runtime, accessibility-tool or real-Run verification was authorized or performed.

2026-10-08 authorized deployment: Gateway and Web builds, API compilation, isolated startup on ports 23490–23492 and deployment readiness on ports 23390–23392 passed through pnpm deploy:local. The deployment platform snapshot reports shared direct Chat/Team Codex execution without WorkLite grants and Chat cancellation in running/waiting states. The original conversation remains cancelled with no pending question. Browser appearance, real Codex task execution, live cancellation interaction and Feishu client behavior were not tested; no test suite or standalone type check was run.

2026-10-08 source comparison: Team developer shares direct Codex execution with Chat, and its Web conversation/Run and Feishu clarification surfaces omit command-grant fields. Non-Codex role fields remain. Runtime, browser, type check, build and test verification were not authorized or performed.

Source-level audit: 2026-10-03. Differences found: none in route and tab state, default Coordinator routing, conditional contextual inspector, responsive stacking, provider-grouped model selectors, role-local advanced settings, save and error feedback, copy inventory, semantic tokens, or keyboard access. Only source review occurred; no browser, runtime, accessibility-tool, or real-Run verification was performed.

## Changelog

### 2026-10-10 - Planner-decided parallelism and progress percentage

- Removed the extra Developer instance list and concurrency bound from role configuration; runtime parallelism (1-4 lanes) is decided by the Planner per Run and shown as Run evidence. Added the completion percentage to the active Run progress summary.

### 2026-10-10 - Parallel Developer configuration and progress

- Added the Developer executor selector, extra Developer instance list (label, executor, model, advanced fields, add up to three, per-instance remove), and the Developer concurrency bound; role and instance executors survive load and save.
- Added active-Run progress summary (phase, assignment completion, active Developers, next step, pending-question count), per-question inspector answer panels beyond the earliest pending question, and per-task retry controls when several assignments failed together.

### 2026-10-08 - Shared direct Codex execution

- Removed WorkLite proposal and command-grant steps for developer tasks; retained clarification and effect recovery.

### 2026-10-03 - Team interaction and role configuration

- Made Coordinator routing the default for new tasks and placed its removable token inside the composer surface.
- Let the conversation use its full width when no contextual Run, queue, recovery, or document inspector is needed.
- Replaced repeated expanded role cards with provider-grouped model selectors and role-local advanced settings disclosures.

### 2026-10-03 - Team conversation

- Replaced the form-first Start specification with the default Team-owned Coordinator conversation and a separate Configuration tab.
- Added durable chat intake, one-action automatic Run creation, remembered directory reuse, concise execution projection, pending questions, file delivery, immutable document viewing, download, and Run evidence links.
- Removed launch-form copy from the admitted inventory and documented conditional scrolling, reconnect replay, keyboard mentions, and accessibility requirements.
