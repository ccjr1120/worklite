# Workspace Chat Bot

## Route

`Embedded workspace surface; opened from Home and workspace-level commands.`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/components/workspace/agent-chat.tsx`

## Purpose

Configure WorkLite through a guided conversation: create providers, Skills, MCP servers, and Workflow drafts, and dispatch work to published Workflows.

## Primary Task

Send a request and read its result. Action budget: one — submit the composer. Focusing the composer expands the panel, so opening the surface costs nothing beyond reaching the input.

Dispatching to a published Workflow costs two actions — select the mention, then submit — because the target is a value the product cannot resolve and only one mention is permitted per task.

## Layout

The expanded conversation panel is centered and capped at `1200px` wide by approximately `680px` high, constrained by `24px` desktop outer space. It contains `Chat` and `Configuration` views in that order, sharing one fixed panel height so switching tabs never resizes the surface.

Configuration belongs to the Chat Bot panel rather than a resource collection. It selects an existing workspace Provider and model pair and multiple workspace MCP servers for Chat Bot. Selection autosaves to the protected Chat Bot configuration, and an unconfigured Chat Bot opens on Configuration by default. Follow the Memory One panel pattern: lightweight top tabs and unframed configuration fields inside the conversation surface.

Home shows a single-line composer by default. Other pages show only a draggable lower-right Chat icon until it is opened; clicking it opens the same centered panel above the current page and focuses the composer. The icon stays inside the viewport safe area.

The conversation is one unframed column. User messages are right-aligned compact neutral bubbles. Chat Bot responses are left-aligned and use the shared Markdown renderer.

## Interaction Contract

### Opening and closing

Composer focus opens the panel without waiting for a submission. Clicking outside, pressing `Escape`, using the icon-only minimize control, or navigating to another page closes it while preserving the current server execution identifier. Chat-owned popup menus remain interactive while the panel is open. Navigating closes the visible panel without cancelling work.

### Submission and cancellation

Only one turn or Skill call may be active. Submitting appends an unframed Agent placeholder with a restrained loader and `Working` label immediately, before any server response. The composer input stays editable while the execution is `running`, but its draft is not submitted or queued.

The icon-only Send target becomes an icon-only Stop target while running; Stop calls the server cancellation endpoint and preserves the current draft. Pressing `Enter` while running neither submits nor stops. After a completed or cancelled turn, submitting another message continues the same execution.

### Self-healing execution state

Execution state is self-healing and exposes no manual refresh. The surface reads the persisted execution and subscribes to its event stream; a dropped stream sets a `reconnecting` state, retries the persisted read with increasing delay, and refreshes immediately when the browser becomes online or visible again. It never submits a duplicate user message.

A failed turn is the one state with a manual recovery action: `Retry last request` continues the same persisted execution. Retry is a recovery from a server-reported failure rather than from observable staleness, so it is a justified exception to the self-healing rule.

### Mentions

Typing `@` opens a searchable menu of configured published Workflows and published Workflows above the composer. It filters from the text after the active `@`, supports pointer selection plus `ArrowUp`, `ArrowDown`, `Enter`, and `Escape`, and stays within the panel width. Published Workflows without a runnable published version are excluded. Draft Workflows are not offered as runnable mentions. Slash-command and mention menus are mutually exclusive.

Selecting a target removes the active `@` query and inserts one removable mention token before the editable task inside the same bordered composer input surface. The textarea has no separate border or background in this state, and focus is shown around the shared mention-and-text surface. The token and task text wrap within that surface rather than becoming adjacent input regions. Only one mention is allowed.

`@` mentions show only published Workflows. Selecting a Workflow creates a version-bound Workflow Run from the remaining message text as its Workflow Input value, then clears the mention and task after the Run is created. Chat Bot does not expose Agent mentions or child sessions.

### Slash commands

The composer accepts local slash commands before ordinary message handling. Typing `/` opens a raised command menu above the composer with `/log`, `/new`, and `/resume` and concise descriptions. It filters as the user types and supports pointer selection, `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` without taking focus away from the composer.

`/log` downloads one readable Markdown document for the active conversation. It preserves server message order rather than re-sorting messages and Skill calls into one ambiguous timeline, keeps user content literal so its Markdown cannot change the document structure, and places a compact Skill activity summary after the transcript with script identity, localized status, and exit code. Raw arguments, output, stack traces, temporary paths, workspace snapshots, and provider responses are excluded from the default document. It includes the conversation status and localized export time, marks a running export as incomplete, and includes a localized safe failure or cancellation reason when present. With no active conversation it shows durable inline feedback instead of downloading an empty document. It never appends to the conversation, calls the model, creates a server record, or includes archived executions.

`/new` archives the active execution identifier and opens a blank conversation while leaving all workspace resources unchanged. An archived execution that is still running remains a visible server-owned background execution and is not silently cancelled. `/resume` opens the execution history selector. Commands are trimmed and case-insensitive, and the panel stays open after execution.

### Session ownership and model calls

Chat Bot owns one protected conversation. Messages use the protected Chat Bot execution and never dispatch to user-managed Agents or child sessions. `@` mentions invoke published Workflows only; the remaining message text is passed as Workflow input and the resulting Run is rendered as a separate transcript entry.

### Skill execution

Chat Bot permanently owns the platform-operation capability. It is an internal Chat capability, not a persisted or assignable Skill resource. The model can request only its server-discovered shebang-bearing scripts through `skill_script`, and every valid request executes immediately on the server. The browser never authorizes the request, calls resource mutation APIs on behalf of a model response, or infers operations from message text, script names, or stdout.

Skill calls appear inline between messages as compact collapsed rows showing the Skill name, script name, automatic execution status, and exit code when available. A disclosure control reveals the exact script path, JSON argument list, working directory, host-permission warning, and output. Details never open automatically for failures, and output uses a height-bounded internal scroller. Skill calls expose no permission, `Run`, or `Reject` actions, and there is no proposal inspector or browser-owned operation card.

Completed resource scripts show their returned resource route as a normal link. Provider results lead to the secure Provider form because credentials cannot be passed through Chat. A completed navigation script may include a server-validated client action; Web applies only that typed route. Appearance and language results come from persisted server settings and are applied after the settings query refreshes.

### Unconfigured entry

When no provider or model is bound, the composer is replaced with one keyboard-accessible inline configuration panel. Once configured, the composer supports ordinary Chat Bot messages and `@` mentions for published Workflows only.

Before the first message, compact task starters may populate requests for Provider, Skill, MCP server, or Workflow creation without fabricating a proposal. The expanded header identifies Chat Bot, shows the current Agent execution status, and provides an icon-only minimize control. A reconnecting execution shows that state separately from the server-owned execution status. A compact diagnostics disclosure may show the safe execution identifier and last-updated time without exposing provider or host secrets.

Workflow Run entries use the same transcript surface: the user input, a compact queued or running state, completion or failure feedback, and successful Artifact cards with direct detail actions. Workflow Run state is never merged into Agent execution state and never exposes a second execution control.

## States

| State | Behavior |
| --- | --- |
| Loading | Loading the persisted execution shows a polite centered status line in the transcript region. The composer shows its own loading line while the Chat Bot configuration resolves. |
| Empty | Before the first message, show the welcome line and compact task starters. |
| No results | The mention and slash menus each show an explicit no-match line rather than collapsing. |
| Error | A failed turn renders its credential-safe reason inline in the transcript with a non-color error cue, a retry action, and a diagnostics disclosure. Cancellation failures render as inline alerts. Raw SDK errors, malformed tool input, provider responses, stack traces, and credentials are never shown. |
| Busy | The Send target becomes Stop while running; the transcript owns the working placeholder so the composer never loses its editable draft. |
| Offline | Inherits `shared-states.md`. Reconnecting is shown separately from execution status and retries with increasing delay. |
| Long content | Skill arguments and output scroll within their own stable regions. The transcript follows the end only while the reader is already at the end. |

Also define unconfigured, submitting, working, executing script, cancelling, cancelled, and completed states. Status always carries a non-color cue. A cancelled turn shows an explicit neutral inline cue even when no Assistant text was produced. Meaningless residual output from a failed model tool request is omitted. A tool batch that exceeds the runtime boundary uses the server-owned `too_many_tool_calls` reason and retry action instead of Provider configuration guidance. Untrusted content is plain text or safe Markdown; script output is preformatted and never rendered as HTML.

## Copy Inventory

| Key | Category |
| --- | --- |
| `assistant:title` | State |
| `assistant:open` | Action |
| `assistant:composer.label` | Action |
| `assistant:composer.placeholder` | Action |
| `assistant:composer.followUpPlaceholder` | Action |
| `assistant:composer.answerPlaceholder` | Action |
| `assistant:composer.send` / `composer.stop` | Action |
| `assistant:composer.loading` | State |
| `assistant:composer.configure` | Recovery |
| `assistant:panelTabs.*` | Action |
| `assistant:configuration.title` | State |
| `assistant:configuration.description` | Constraint |
| `assistant:configuration.model` / `configuration.placeholder` | Action |
| `assistant:configuration.saving` | State |
| `assistant:configuration.mcpServers` | Action |
| `assistant:configuration.mcpServersHint` | Constraint |
| `assistant:starters.title` | State |
| `assistant:starters.*.title` | Action |
| `assistant:starters.*.description` | Constraint |
| `assistant:starters.*.prompt` | Action |
| `assistant:minimized.minimize` | Action |
| `assistant:commands.menuLabel` | State |
| `assistant:commands.logDescription` / `newDescription` / `resumeDescription` | Constraint |
| `assistant:messages.welcome` | Recovery |
| `assistant:speaker.you` / `speaker.assistant` | State |
| `assistant:status.*` | State |
| `assistant:execution.loading` / `working` / `cancelled` | State |
| `assistant:execution.loadFailed` / `requestFailed` / `providerRequestFailed` / `skillFailed` / `incompleteSkillRequest` / `invalidSkillRequest` / `cancelFailed` / `answerFailed` / `restarted` | Recovery |
| `assistant:execution.retry` | Action |
| `assistant:execution.diagnostics` | Action |
| `assistant:execution.id` / `phase` / `errorCode` / `updated` / `none` | State |
| `assistant:mentions.menuLabel` | State |
| `assistant:mentions.empty` | State |
| `assistant:mentions.remove` / `removeWorkflow` | Action |
| `assistant:mentions.workflow` | State |
| `assistant:history.title` | State |
| `assistant:history.description` | Constraint |
| `assistant:history.empty` / `untitled` | State |
| `assistant:history.remove` | Action |
| `assistant:tool.*` | State, except `tool.expand` / `tool.collapse` / `tool.openSecureProvider` / `tool.openResource` which are Action and `tool.warning` which is Constraint |
| `assistant:log.*` | State, except `log.noActive` which is Recovery |
| `assistant:workflowRun.requestFailed` / `cancelFailed` | Recovery |
| `assistant:workflowRun.emptyInput` / `currentStep` / `waitingForConfirmation` | State |
| `assistant:workflowRun.openRunHistory` | Recovery |

Removed keys:

- `assistant:description` ("Configure WorkLite through persisted Agent executions."): it restates the surface title and describes the persistence mechanism rather than anything the reader acts on.
- `assistant:configuration.hint` ("Changes are saved automatically."): the configuration view already shows `configuration.saving`, so the sentence duplicates what a visible component communicates.

## Accessibility

The composer's visible label is provided as screen-reader-only text bound to the input. The input is a `combobox` with `aria-expanded` reflecting whether the slash or mention menu is open; both menus are `listbox` regions whose items are `option` elements with `aria-selected`.

Send and Stop share one stable target with the same dimensions and distinct localized accessible names. Panel tabs are a `tablist` with roving `tabIndex` and arrow-key movement. The collapsed panel is marked `aria-hidden` and `inert` so its controls leave the tab order entirely.

All icon-only controls carry accessible names and tooltips, except the intentionally unobtrusive cross-page floating Chat entry, which keeps an accessible name without a visible tooltip and exposes the current execution status as screen-reader-only text. Skill-call rows are buttons with `aria-expanded` and an accessible name that states whether activating them shows or hides details.

Working, cancelled, clarification, and Workflow Run regions are `role="status"`; failures are `role="alert"`. Conversation and Skill-call status changes use restrained live-region announcements without announcing every token. Keyboard focus remains in the editable composer after cancellation, history selection, and automatic execution updates. Reduced-motion mode replaces spinner motion with the same static working cue. Messages use neutral surface contrast and speaker labels rather than color alone.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/components/workspace/agent-chat.tsx`:

- The transcript does not expose an `aria-live` region for streaming updates. Working, cancelled, and failure blocks use `role="status"` and `role="alert"`, which announce on mount, but the incremental assistant response itself is not announced, so the restrained live-region requirement in this specification is unmet.
- The panel is rendered whenever `isHome || open` and collapsed with `h-0` plus `aria-hidden`/`inert`. On Home the collapsed panel therefore stays mounted and its queries stay active, which is intended for session continuity but is not documented as a mount contract.
- Archived executions are capped by `HISTORY_LIMIT` in browser storage with no user-facing indication that older entries are dropped, so `/resume` can silently stop offering a conversation the user remembers.
- `error` is one component-level string shared by Chat Bot and cancellation failures.
- The floating Chat entry exposes status as `sr-only` text inside the button, making the accessible name and the status concatenate for screen readers rather than remaining distinct.
- Mobile height uses `max-md:h-[min(70vh,680px)]`, matching the `70vh` cap, but the `12px` outer-margin requirement from `shared/responsive-behavior.md` is applied by the parent container rather than this surface, so the constraint is not verifiable from this component alone.

## Changelog

### 2026-09-19 - Copy cleanup

- Removed `assistant:configuration.hint` from both locales: the save indicator already reports that configuration is saved, and the string was rendered twice in the same panel.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, a consolidated accessibility section, and verified coverage findings.
- Recorded execution state as self-healing through the event stream and persisted read, and documented failed-turn retry as a justified manual exception because it recovers a server-reported failure rather than observable staleness.
- Removed `assistant:description` as a restated heading and `assistant:configuration.hint` as text duplicating the visible saving state.

### 2026-09-15

- Added published Workflow `@` mentions to the embedded chat, with remaining-message input mapping and inline Run and Artifact presentation separate from Agent sessions.

### 2026-09-09

- Confirmed that the workspace composer always uses the built-in Chat Bot Agent; removed composer Agent/plugin switching and retained single Workflow dispatch through `@` mentions.

### 2026-09-09

- Confirmed that the composer always uses the built-in Agent target; removed Agent/plugin target switching and retained single Workflow dispatch through `@` mentions.

### 2026-09-04

- Added actionable inline failure guidance for model steps that request too many tools at once without changing the existing retry or diagnostics layout.

### 2026-09-03

- Moved Chat Bot configuration into the chat panel with Configuration and Conversation views; configuration selects existing workspace Provider/model pairs.

- Changed cross-page Chat minimization to a draggable lower-right icon that opens and focuses the composer, while Home retains its visible input.
- Use the Agent icon without a Tooltip for the floating entry and close expanded Chat when the pointer lands outside its surface.

### 2026-08-29

- Added plugin target support to the earlier implementation. This behavior is superseded by the 2026-09-09 decision that the composer has one built-in Agent target.

### 2026-08-28

- Added reconnecting and safe diagnostics states for persisted Agent executions, including retry and execution identifier disclosure.
- Defined request-generation guards, online/visibility refresh, server-owned execution recovery and restoration of the active Chat Bot conversation.
- Clarified that `/new` creates a new main conversation boundary without cancelling an archived background execution.

### 2026-08-28

- Placed the selected Workflow mention and task text inside one shared composer input surface.
- Added structured `@` dispatch to published Workflows with independent Workflow Run presentation in the Chat Bot transcript.
- Replaced the chat transcript and composer primitives with local AI Elements-compatible Conversation, Message, and Prompt Input components backed by the existing server execution contract.

### 2026-08-27

- Added persistent localized inline failure and cancellation cues, omitted meaningless residual model output, and required `/log` to include only the safe failure or cancellation reason.
- Defined `/log` as an active-conversation-only export with server-ordered messages, safe literal user content, localized metadata, incomplete-state disclosure, and compact Skill activity separated from the transcript.
- Clarified that `/new` establishes the next conversation boundary and that archived executions are never merged into `/log`.
- Collapsed inline Skill calls into compact summary rows by default and moved metadata, host warnings, and bounded output behind accessible disclosure.
- Moved active-turn loading into an Agent placeholder in the transcript and kept the composer draft editable while work continues.
- Replaced Send with Stop during active turns, added server-backed cancellation and cancelled presentation, and intentionally omitted message queuing.

### 2026-08-27

- Removed Skill-call permission decisions, `Run` and `Reject` actions, and approval-specific states from Chat Bot.
- Made validated assigned-Skill requests execute automatically while Web remains a read-only observer of execution state and results.

### 2026-08-27

- Replaced browser-owned proposals and the Chat Bot stream protocol with persisted generic Agent executions and inline `skill_script` approvals.
- Required all platform mutations to execute through product-owned `worklite-platform` scripts and server APIs; Web now renders results and applies only typed server-validated navigation actions.
- Made `/new`, `/resume`, and `/log` operate on server execution identifiers and rendered execution data instead of local proposal state.

### 2026-08-26

- Bound Chat Bot to the protected `worklite-platform` Skill and required model-emitted, server-validated platform actions instead of browser text heuristics.
- Added Workflow draft creation and confirmed appearance or language changes while retaining immediate allowlisted navigation and secure Provider credential forms.

### 2026-08-26

- Added an accessible filtered slash-command menu above the composer.
- Changed `/log` to download the generated Markdown transcript without appending it to conversation history.
- Grounded workspace inventory answers in the API-provided credential-safe resource snapshot.

### 2026-08-26

- Disabled browser autocomplete history for the transient composer.
- Added visible, removable FIFO message queue rows while preserving one active model stream.
- Defined failure pause, retry resume, current-history assembly, and minimized queue-count behavior.
- Limited structured proposals to explicit resource setup requests so ordinary conversation does not show a false review action.
- Renamed minimized proposal status from tool-call wording to proposal wording.

### 2026-08-26

- Added local `/log` transcript-document output and `/new` browser-session reset commands.

### 2026-08-26

- Capped the complete Agent Chat surface at `1200px`, centered it, and standardized message-region horizontal padding at `16px` without a nested message-width constraint.

### 2026-08-26

- Simplified the configured bottom composer to its input and send action without a repeated visible title.
- Right-aligned user messages and left-aligned Agent responses with a wider unframed reading column.
- Replaced complete replies with incremental NDJSON assembly through the shared streaming Markdown renderer.

### 2026-08-26

- Replaced mock assistant replies with real model responses from the provider bound to Agent Chat.
- Kept the browser-lifetime conversation and local structured proposal simulation without server persistence.
- Replaced the unconfigured composer with a direct link to the protected Agent Chat provider form.

### 2026-08-26

- Assigned Agent Chat provider binding to its protected system Agent editor without adding Chat-surface configuration.

### 2026-08-25

- Reframed Agent Chat as a single personal workspace assistant and removed team-keyed session behavior.

### 2026-08-24

- Unified Agent Chat expansion dimensions across Home and other pages while keeping proposal inspection Home-specific on wide screens.

### 2026-08-20

- Moved session ownership to the workspace shell, keyed sessions by team, and required route changes to close without clearing state.
- Added the focus-opened single-line composer, constrained Home panel, and lower-right cross-page popover.
- Moved Agent Chat into Home with a persistent composer, upward-expanding conversation layer, and compact minimized execution status.
- Converted the assistant route to a compatibility redirect and removed the separate primary navigation destination.
- Established the Agent Chat route, guided task starters, structured proposal review, explicit confirmation, secure-input boundary, responsive behavior, and local-prototype state.
