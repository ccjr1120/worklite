# Workspace System Helper Chat

## Route

`Embedded workspace surface; opened from Home and workspace-level commands.`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/components/workspace/agent-chat.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Purpose

System Helper Chat helps a person configure a model provider and create Skills, connect MCP servers, and create Agents through a guided conversation. It is a task-oriented assistant owned by the workspace shell, presented as the same full-width expandable panel on Home and other pages. It is not the default representation of the rest of the product.

The canonical route is `/home`. System Helper Chat appears in command search but not as a separate primary navigation destination. The shell surface always uses the built-in System Helper Agent. Other configured custom Agents and published Workflows are invoked per message through an `@` mention; there is no composer-side target picker. Agent mentions create Agent turns, while Workflow mentions create version-bound Workflow Runs. The remaining message text becomes the Workflow Input value, and Draft Workflows are not offered as runnable mentions.

## Layout

The expanded conversation panel includes `Chat` and `Configuration` views in that order. Configuration belongs to the panel rather than the Agent collection and lets users select an existing workspace Provider/model pair and multiple workspace MCP servers for System Helper. Selection autosaves to the protected system Agent; an unconfigured helper opens on Configuration by default. Follow the earlier Memory One panel pattern: lightweight top tabs and unframed configuration fields inside the conversation surface. Both views share the same fixed panel height so switching tabs does not resize the surface.

Keep the workspace shell stable. Home shows a single-line composer by default; other pages show a draggable lower-right Chat icon by default. Clicking the icon opens a centered conversation panel above the current page and focuses the composer. Composer focus also opens the panel. The icon remains keyboard accessible and stays within the viewport safe area. Navigating closes the panel while preserving the current server execution identifier.

The expanded header identifies System Helper Chat, shows the current Agent execution status, and provides an icon-only minimize control. When an execution is reconnecting, show that state separately from the server-owned execution status. A compact diagnostics disclosure may show the safe execution identifier and last-updated time without exposing provider or host secrets. Before the first message, compact task starters may populate requests for Provider, Skill, MCP server, or Agent creation without fabricating a proposal. When no provider or model is bound and no configured custom Agent is available, replace the composer with one keyboard-accessible setup link to `/agents/agt_system_helper_chat`. If a configured custom Agent is available, keep the composer for structured `@` dispatch while ordinary System Helper submission remains disabled. The composer does not provide an Agent or plugin target switcher. System Helper remains the only built-in target and handles ordinary messages. Other configured custom Agents are selected with `@` in the composer; plugin execution is not exposed as a composer target.

The conversation is one unframed column. Workflow Run entries use the same transcript surface: show the user input, a compact queued/running state, completion or failure feedback, and successful Artifact cards with direct detail actions. Do not merge Workflow Run state into Agent execution state or expose a second execution control.

The conversation is one unframed column. User messages are right-aligned compact neutral bubbles. Agent responses are left-aligned and use the shared Markdown renderer. Immediately after submitting a user message, append an unframed Agent placeholder with a restrained loader and `Working` label in the message region. Keep it after inline Skill calls while the model resumes, and replace it with final content, a localized inline failure with a non-color error cue, or a localized non-color cancelled cue when the turn ends. Failure copy comes from a credential-safe server error and remains visible after reload; raw SDK errors, malformed tool input, provider responses, stack traces, and credentials are never shown. Skill calls appear inline between messages as compact collapsed rows showing the Skill name, script name, automatic execution status, and exit code when available. A disclosure control reveals the exact script path, JSON argument list, working directory, host-permission warning, and output. Details never open automatically for failures, and output uses a height-bounded internal scroller. Skill calls do not expose permission, `Run`, or `Reject` actions. Do not add a proposal inspector or browser-owned operation cards.

When child sessions exist, place a compact unframed `Sub Agents` band between the transcript and composer. Its horizontally scrollable items show Agent identity, execution status, and unread state without relying on color. Selecting an item replaces the transcript with that child's persisted conversation and changes the composer target. The active child view provides an explicit icon action to return to System Helper and an icon action to close and delete the child session.

## Session Ownership And Model Calls

System Helper Chat uses the normal server-owned Agent execution endpoints. The browser stores the active execution identifier and optional archived identifiers for `/new` and `/resume`; messages, tool requests, automatic execution states, outputs, and errors come from the server execution. A browser reload fetches the current execution rather than reconstructing it from model text or local proposal state.

Only one turn or Skill call may be active. The composer input remains editable while the execution is `running`, but its draft is not submitted or queued. The icon-only Send action becomes an icon-only Stop action while running; Stop calls the server cancellation endpoint and preserves the current draft. Pressing `Enter` in the single-line composer while running does not submit or stop the turn. After a completed or cancelled turn, submitting another message continues the same execution. `/new` ends the current conversation boundary by archiving its active identifier and starts a new execution on the next message. `/resume` selects a previously archived execution identifier. `/log` downloads only the active execution and never combines archived executions.

Each child session owns one normal custom-Agent execution and persists independently from the System Helper execution. Creating a child sends the selected Agent identifier and task through the sub-session API, then renders the linked execution. Follow-up messages use the existing continuation endpoint and Stop uses the existing cancellation endpoint. Child work does not block the main composer, never appears in the main transcript or model context, and survives browser reload. The selected child identifier is restored when available. The server owns terminal unread transitions; opening a child clears its unread marker, while completion, failure, or restart recovery marks it unread when another transcript is selected. `/new`, `/resume`, and `/log` continue to operate only on the main conversation. A server restart may replace an unrecoverable running state with its persisted safe failure reason. Plugin conversations use the same execution boundary and history commands, but their selected target is restored separately and their transcript responses are labeled with the active plugin.

## Skill Execution

System Helper Chat permanently owns the platform-operation capability. It is an internal Chat capability, not a persisted or assignable Skill resource. The model can request only its server-discovered shebang-bearing scripts through `skill_script`. Every valid request executes immediately on the server. The browser never authorizes the request, calls resource mutation APIs on behalf of a model response, or infers operations from message text, script names, or stdout.

Completed resource scripts show their returned resource route as a normal link. Provider results lead to the secure Provider form because credentials cannot be passed through Chat. A completed navigation script may include a server-validated client action; Web applies only that typed route. Appearance and language results come from persisted server settings and are applied after the settings query refreshes.

## States

Define unconfigured, empty, submitting, working, executing script, cancelling, cancelled, completed, failed, reconnecting, and long-content states. Status always includes a non-color cue. A failed turn shows its safe actionable reason inline in the transcript region, includes a retry action that continues the same persisted execution, and exposes the safe execution identifier for support. A cancelled turn shows an explicit neutral inline cue even when no Assistant text was produced. Meaningless residual output from a failed model tool request is omitted. Untrusted content is plain text or safe Markdown; script output is preformatted and never rendered as HTML. Reconnecting retries the persisted execution read with increasing delay and immediately refreshes when the browser becomes online or visible again; it never submits a duplicate user message.

## Responsive Behavior

Use the same constrained panel on Home and other pages. Below `768px`, use the available width minus `12px` outer margins and at most about `70vh`; never make the conversation full-screen. Script arguments and output scroll within their own stable regions, and active execution status remains visible above mobile browser controls.

## Sub-Agent Mentions And Sessions

Typing `@` in the main composer opens a searchable menu of configured custom Agents above the composer. The menu filters from the text after the active `@`, supports pointer selection plus `ArrowUp`, `ArrowDown`, `Enter`, and `Escape`, and remains within the panel width. Protected Agents and custom Agents without both a Provider and model are excluded. Slash-command and Agent menus are mutually exclusive.

Selecting an Agent removes the active `@` query and inserts one removable mention token before the editable task inside the same bordered composer input surface. The textarea has no separate border or background in this state, and focus is shown around the shared mention-and-text surface. The token and task text wrap within that surface rather than becoming adjacent input regions. Only one mention is allowed. Submitting with a mention creates a child session from the remaining task verbatim, clears the mention and task after success, and immediately switches to the child transcript. Submitting without a mention retains the normal System Helper behavior. Once a child is selected, its composer accepts ordinary follow-up text and does not offer nested `@` dispatch.

The main composer remains available while any child runs. Selecting a running child shows Stop for that child only. Closing a child cancels active work, deletes its persisted session and linked execution, and returns to System Helper when the closed child was active. Opening a child clears its unread marker; completion or failure while another transcript is selected marks it unread.

## Slash Commands

The composer accepts local slash commands before ordinary message handling. Typing `/` opens a raised command menu above the composer with `/log`, `/new`, and `/resume`, including concise descriptions. The menu filters as the user types and supports pointer selection, `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` without taking focus away from the composer. It uses semantic surfaces, borders, text, selection, and focus tokens in both themes and remains within the System Helper Chat width on mobile.

`/log` downloads one readable Markdown document for the active conversation. Preserve server message order in the transcript instead of re-sorting messages and Skill calls into one ambiguous timeline. Keep user content literal and prevent its Markdown from changing the document structure. Place a compact Skill activity summary after the transcript with script identity, localized status, and exit code; exclude raw arguments, output, stack traces, temporary paths, workspace snapshots, and provider responses from the default document. Include the conversation status and localized export time, mark a running export as incomplete, and include a localized safe failure reason or cancellation reason when present. When there is no active conversation, show durable inline feedback instead of downloading an empty document. The command does not append content to the conversation, call the model, create a server record, or include archived executions.

`/new` archives the active execution identifier and opens a blank conversation while leaving all workspace resources unchanged. If the archived execution is still running, it remains a visible server-owned background execution and is not silently cancelled by the boundary command. Its command description must make that conversation boundary explicit. `/resume` opens the execution history selector. Commands are trimmed and case-insensitive, and the panel remains open after execution.

## Accessibility And Themes

Use semantic surface, border, text, brand, and status tokens in both light and dark modes. Persimmon indicates the primary action, current selection, or active execution only. Messages use neutral surface contrast and speaker labels rather than color alone.

All icon-only controls require accessible names and tooltips, except the intentionally unobtrusive cross-page floating Chat entry, which keeps an accessible name without a visible Tooltip. Send and Stop retain the same stable target dimensions and expose distinct localized accessible names. Clicking outside an expanded Chat surface closes it; Chat-owned popup menus remain interactive. Conversation and Skill-call status changes use restrained live-region announcements. Keyboard focus remains in the editable composer after cancellation, history selection, and automatic execution updates. Reduced-motion mode replaces spinner motion with the same static working cue.

## Changelog

### 2026-09-15

- Added published Workflow `@` mentions to the embedded chat, with remaining-message input mapping and inline Run and Artifact presentation separate from Agent sessions.

### 2026-09-09

- Confirmed that the workspace composer always uses the built-in System Helper Agent; removed composer Agent/plugin switching and retained single custom-Agent dispatch through `@` mentions.

### 2026-09-09

- Confirmed that the composer always uses the built-in System Helper Agent; removed Agent/plugin target switching and retained single custom-Agent dispatch through `@` mentions.

### 2026-09-03

- Moved System Helper configuration into the chat panel with Configuration and Conversation views; configuration selects existing workspace Provider/model pairs.

- Changed cross-page Chat minimization to a draggable lower-right icon that opens and focuses the composer, while Home retains its visible input.
- Use the Agent icon without a Tooltip for the floating entry and close expanded Chat when the pointer lands outside its surface.

### 2026-08-29

- Added plugin target support to the earlier implementation. This behavior is superseded by the 2026-09-09 decision that the composer has one built-in Agent target.

### 2026-08-28

- Added reconnecting and safe diagnostics states for persisted Agent executions, including retry and execution identifier disclosure.
- Defined request-generation guards, online/visibility refresh, server-owned child unread transitions, and restoration of the selected child session.
- Clarified that `/new` creates a new main conversation boundary without cancelling an archived background execution.

### 2026-08-28

- Placed selected Agent mentions and task text inside one shared composer input surface.
- Added structured `@` dispatch to configured custom Agents, persistent child-session navigation, independent child transcripts, follow-up, Stop, unread, return, and close behavior.
- Replaced the chat transcript and composer primitives with local AI Elements-compatible Conversation, Message, and Prompt Input components backed by the existing server execution contract.

### 2026-08-27

- Added persistent localized inline failure and cancellation cues, omitted meaningless residual model output, and required `/log` to include only the safe failure or cancellation reason.
- Defined `/log` as an active-conversation-only export with server-ordered messages, safe literal user content, localized metadata, incomplete-state disclosure, and compact Skill activity separated from the transcript.
- Clarified that `/new` establishes the next conversation boundary and that archived executions are never merged into `/log`.
- Collapsed inline Skill calls into compact summary rows by default and moved metadata, host warnings, and bounded output behind accessible disclosure.
- Moved active-turn loading into an Agent placeholder in the transcript and kept the composer draft editable while work continues.
- Replaced Send with Stop during active turns, added server-backed cancellation and cancelled presentation, and intentionally omitted message queuing.

### 2026-08-27

- Removed Skill-call permission decisions, `Run` and `Reject` actions, and approval-specific states from System Helper Chat.
- Made validated assigned-Skill requests execute automatically while Web remains a read-only observer of execution state and results.

### 2026-08-27

- Replaced browser-owned proposals and the System Helper stream protocol with persisted generic Agent executions and inline `skill_script` approvals.
- Required all platform mutations to execute through product-owned `worklite-platform` scripts and server APIs; Web now renders results and applies only typed server-validated navigation actions.
- Made `/new`, `/resume`, and `/log` operate on server execution identifiers and rendered execution data instead of local proposal state.

### 2026-08-26

- Bound System Helper Chat to the protected `worklite-platform` Skill and required model-emitted, server-validated platform actions instead of browser text heuristics.
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
