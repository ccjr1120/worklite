# Agent Team Group

## Route

`/agent-team-groups/:groupId`

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/responsive-behavior.md`
- `ui-ux-design/pages/chat/workspace/DESIGN.md`
- `ui-ux-design/pages/agent-teams/detail/DESIGN.md`

## Implementation

- `apps/web/src/routes/agent-team-groups/$groupId.tsx`
- `apps/web/src/features/agent-teams/group-chat.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/queries.ts`

## Purpose

Start and guide Team work through a durable role-addressed group conversation.

## Primary Task

Send one message to Team Manager or an active work role. Action budget: one message submission. A new empty group is created from the Team records action; each user message starts a separate group-bound Run. An unaddressed message goes to Team Manager. No repository selection precedes the first message: an unscoped work-role message creates an empty-scope Run, and the addressed role identifies the project directory from context or asks for it in the group.

## Layout

A full-height conversation surface following the Chat workspace grammar: a stable header with the back-to-records link and the group title, a chronological persisted transcript filling the main column, and a floating composer card pinned at the bottom. Both themes use shared neutral surfaces and semantic tokens.

User messages are right-aligned `brand-subtle` plain-text bubbles; role messages are left-aligned in an unframed reading column with a role identity badge; system and status entries render as inline notes without identity marks. Messages carry repository labels when scoped. Handoffs show the sender, recipient and file references; file references link to the associated Run evidence. Each new message enters with a short fade and rise. The transcript follows new content only while the reader is at the bottom, and a return-to-end control appears while they are not.

An unsettled or failed Run renders as a card inside the transcript at the position of its latest activity, the way Chat inlines its workflow-run and failure entries: a running, queued, waiting or paused Run shows a quiet status row with the role badge, shared status semantics, the intent summary, its pause/resume and stop controls and the open-Run link; a failed Run shows a danger-subtle card with the role badge, the failure reason, and retry, reexecute and open-Run controls. Settled Runs leave no card; their evidence remains in the transcript and on the Run detail route. Execution activity and raw command output stay on the Run detail route. Team memory and working-practice management live in Team Configuration.

The composer is the shared floating rounded card: an auto-growing textarea with `Enter` to send and `Shift+Enter` for a newline (IME composition is confirmed first), an add-directory action opening a dialog that accepts an absolute path, and a pill submit control reporting its own progress. With no recipient token, the message goes to Team Manager. Typing `@` opens a keyboard-accessible role menu that filters as the user types; a selection becomes one removable `@role` token inside the same input surface and sets the recipient. The menu always includes the protected Team Manager plus every role in the current Team configuration; custom roles use their configured display names. Team Manager is a narrower Chat Agent: it can inspect and update only this Team's configuration, work roles and memories through typed operations, and has no project-path, project-file, Command, Skill, MCP or general workspace tools. The typed commands `@role pause|resume|cancel|retry|reexecute` remain accepted. The composer never requires a repository selection; when the message omits one, the server applies the group's default repository scope.

A Run's pending question renders as an amber question card inside the transcript with its Markdown question text, an answer field, and the exact-command field where supplied; while the Run has no repositories, the card adds an optional absolute-directory field whose submitted directories bind as the Run's repository scope on acceptance. An answered question settles into a quiet question line plus the user's answer message. Send- and control-stage failures render as an inline alert at the end of the transcript, and a graph-level Run failure is posted by the server as a system status message in the transcript itself.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Send group message | Address Team Manager by default or choose a role through the `@` menu or an explicit `@role` prefix, then persist one message with its submission id and create a group-bound Run. No repository selection is required; an omitted scope defaults to every group repository, and an empty-scope work-role Run asks the role to identify or request the project directory. Delivery state appears in the transcript. |
| Answer question | Submit the answer in the question card; progress and failures stay on that control. Optional absolute directories submitted with the answer register as group repositories and bind to that Run's scope in the same acceptance. |
| Add repository | Open the directory dialog from the composer and submit one absolute path; the new repository joins the group's default scope. |
| Handoff | A structured handoff records the sender, recipient, summary and document references, then advances the same Run to its next role. |
| Manage Team | Address `@team-manager` in one message; its typed Team operations inspect and update Team configuration, create/update/delete work roles, and manage Team memories. The accepted Run keeps its captured TeamVersion; later Runs use the changed configuration. |
| Role task control | Select pause, resume, retry, cancel or reexecute from the Run's own transcript card; the control reports progress on itself. Pause/resume/cancel act on the whole Run. |
| Read document | Open the associated Run and access the immutable document revision there; roles read files on demand. |
| Manage memory | Open `/agent-teams/:teamId/configuration` to create, edit or delete memories with Team/repository/role scope. |

The server event stream owns freshness. Controls remain available while a message is being sent, and sending never locks a Run card.

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain the header and transcript geometry. |
| Empty group | Composer-first empty state explains that messages go to Team Manager by default and `@` selects a work role; the send action is enabled without repositories. |
| Empty-scope Run | Team Manager can handle Team administration without a project directory; an addressed work role identifies one from context or asks through a question card, and bound directories appear as repository evidence. |
| Waiting for information | The Run's question card keeps its answer form visible, including the exact-command field and the optional directory field where applicable; other Runs remain independent. |
| Running | Run cards in the transcript show current role and Run status; role messages appear around them. |
| Paused Run | The Run's card shows the paused state and resume control; other Runs continue. |
| Failed | Keep partial messages and Run evidence; the server posts the failure as a transcript status message, the Run's card offers retry and reexecute, and `@role reexecute` stays available in the composer. |
| Offline | Reconnect the event stream and invalidate the persisted group snapshot without duplicate messages. |
| Long content | Render safe Markdown in messages; open Run detail for execution activity, command output and document content. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:group.empty.title` / `description` | State |
| `agentTeams:group.untitled` / `transcript` / `backToRecords` | State / Action |
| `agentTeams:group.you` / `system` | State |
| `agentTeams:group.recipient` | Action |
| `agentTeams:group.role.teamManager` / `role.customName` | State |
| `agentTeams:group.teamManager.*` | Action / State / Recovery |
| `agentTeams:group.mention.menuLabel` / `empty` / `remove` | State / Action |
| `agentTeams:group.messagePlaceholder` | Action |
| `agentTeams:group.send` / `sending` | Action / State |
| `agentTeams:group.noRoleTask` / `sendFailed` | Recovery |
| `agentTeams:group.deliveryPending` / `deliveryFailed` | State / Recovery |
| `agentTeams:group.repositories` / `repositoryDirectory` / `addRepository` / `addRepositoryHint` / `repositoryAddFailed` | State / Constraint / Action / Constraint / Recovery |
| `agentTeams:group.pause` / `continue` / `stop` | Action |
| `agentTeams:group.retry` / `reexecute` / `openRun` | Recovery / Action |
| `agentTeams:group.answerPlaceholder` / `authorizedCommands` / `authorizedCommandsHint` / `commandsPlaceholder` | Action / Constraint |
| `agentTeams:group.answerDirectories` / `answerDirectoriesHint` | Constraint |
| `agentTeams:group.answer` / `answering` / `answerFailed` | Action / State / Recovery |
| `agentTeams:group.noMessages` / `noRepositories` / `runCount` / `status.empty` | State |
| `agentTeams:group.backToBottom` | Action |
| `agentTeams:group.loadFailed` / `unavailable.*` / `controlFailed` | Recovery |

## Accessibility

The `@` role menu supports keyboard navigation, visible focus and screen-reader labels, and focus never leaves the textarea while it is open. Every role, Run and repository is identified in text. Status updates use polite regions without announcing every token. Pause, retry and cancel controls identify the Run scope. The return-to-end control and the remove-recipient control have accessible names. Both themes and reduced-motion behavior inherit shared components.

## Coverage Status

2026-10-19 source comparison after the transcript-inlined Run cards redesign: the task band above the composer is gone. Unsettled and failed Runs render as cards inside the transcript at the position of each Run's latest message — a quiet status row for queued/running/waiting/paused Runs with pause, resume, stop and open-Run controls, and a danger-subtle failure card with the server-posted failure reason plus retry, reexecute and open-Run controls. The role-wide pause/resume row and the read-only working-practice line are removed; their `group.pauseAll`, `group.continueAll`, `group.workingPractice`, `group.noWorkingPractice` and `group.editWorkingPractice` keys are deleted from the locale file. The add-directory action moved into the composer card as an icon button opening the same dialog. Send- and control-stage errors stay as the inline transcript alert. Server side, `handleGraphFailure` now posts a graph-level Run failure as a system status message in the group transcript, so a failed Run is visible in the conversation itself; `createGroupRun` and `executeTask` reject a Team Manager task early with a clear model-configuration error when `team-manager` has no configured model, and the configuration page no longer disables the Team Manager model selector. Team Manager remains protected (non-deletable, fixed typed tool set). Static source comparison only; no browser interaction, build, test suite or deployment was run.


## Changelog

### 2026-10-19

- Replaced the composer-top task band with transcript-inlined Run status cards following the Chat grammar; removed the role-wide batch controls and the working-practice line, and moved the add-directory action into the composer.
- Posted graph-level Run failures into the group transcript as system status messages, and made an unconfigured Team Manager model fail fast with a clear error; the Team Manager model selector is editable in Team configuration.

### 2026-10-19

- Added the protected in-group Team Manager as a narrowed Chat Agent for Team configuration, role CRUD and Team memory operations.
- Made the `@` recipient menu and work-role context dynamic while preserving immutable role snapshots on accepted Runs.

### 2026-10-19

- Adopted the Chat conversation grammar: full-height transcript, floating composer with `@` role mention token, in-transcript question cards, return-to-end control, and a compressed Run task band replacing the repository/Run/working-practice side panel.
- Removed the repository precondition from sending: unscoped messages create empty-scope Runs, and directories bind through role-identified `repositoryDirectories` or answer-carried `directories`; the per-message repository checkboxes are removed in favour of the server's default group scope.
- Routed the working-practice action to the separate Team configuration page.
