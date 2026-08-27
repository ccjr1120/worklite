# Workspace System Helper Chat

## Purpose

System Helper Chat helps a person configure a model provider and create Skills, connect MCP servers, and create Agents through a guided conversation. It is a task-oriented assistant owned by the workspace shell, presented as the same full-width expandable panel on Home and other pages. It is not the default representation of the rest of the product.

The canonical route is `/home`. System Helper Chat appears in command search but not as a separate primary navigation destination.

## Layout

Keep the workspace shell stable. Every page shows a single-line composer by default. Composer focus opens a centered conversation panel above the current page, fluid up to a `1200px` maximum width. Navigating closes the panel while preserving the current server execution identifier.

The expanded header identifies System Helper Chat, shows the current Agent execution status, and provides an icon-only minimize control. Before the first message, compact task starters may populate requests for Provider, Skill, MCP server, or Agent creation without fabricating a proposal. When no provider or model is bound, replace the composer with one keyboard-accessible setup link to `/agents/agt_system_helper_chat`.

The conversation is one unframed column. User messages are right-aligned compact neutral bubbles. Agent responses are left-aligned and use the shared Markdown renderer. Immediately after submitting a user message, append an unframed Agent placeholder with a restrained loader and `Working` label in the message region. Keep it after inline Skill calls while the model resumes, and replace it with final content or a non-color cancelled cue when the turn ends. Skill calls appear inline between messages as compact collapsed rows showing the Skill name, script name, automatic execution status, and exit code when available. A disclosure control reveals the exact script path, JSON argument list, working directory, host-permission warning, and output. Details never open automatically for failures, and output uses a height-bounded internal scroller. Skill calls do not expose permission, `Run`, or `Reject` actions. Do not add a proposal inspector or browser-owned operation cards.

## Session Ownership And Model Calls

System Helper Chat uses the normal server-owned Agent execution endpoints. The browser stores the active execution identifier and optional archived identifiers for `/new` and `/resume`; messages, tool requests, automatic execution states, outputs, and errors come from the server execution. A browser reload fetches the current execution rather than reconstructing it from model text or local proposal state.

Only one turn or Skill call may be active. The composer input remains editable while the execution is `running`, but its draft is not submitted or queued. The icon-only Send action becomes an icon-only Stop action while running; Stop calls the server cancellation endpoint and preserves the current draft. Pressing `Enter` in the single-line composer while running does not submit or stop the turn. After a completed or cancelled turn, submitting another message continues the same execution. `/new` clears the active identifier and starts a new execution on the next message. `/resume` selects a previously archived execution identifier. `/log` downloads the currently rendered server transcript and tool-call details without creating a resource.

## Skill Execution

System Helper Chat permanently owns the protected `worklite-platform` Skill. The model can request only its server-discovered shebang-bearing scripts through `skill_script`. Every valid request executes immediately on the server. The browser never authorizes the request, calls resource mutation APIs on behalf of a model response, or infers operations from message text, script names, or stdout.

Completed resource scripts show their returned resource route as a normal link. Provider results lead to the secure Provider form because credentials cannot be passed through Chat. A completed navigation script may include a server-validated client action; Web applies only that typed route. Appearance and language results come from persisted server settings and are applied after the settings query refreshes.

## States

Define unconfigured, empty, submitting, working, executing script, cancelling, cancelled, completed, failed, reconnecting, and long-content states. Status always includes a non-color cue. Untrusted content is plain text or safe Markdown; script output is preformatted and never rendered as HTML.

## Responsive Behavior

Use the same constrained panel on Home and other pages. Below `768px`, use the available width minus `12px` outer margins and at most about `70vh`; never make the conversation full-screen. Script arguments and output scroll within their own stable regions, and active execution status remains visible above mobile browser controls.

## Slash Commands

The composer accepts local slash commands before ordinary message handling. Typing `/` opens a raised command menu above the composer with `/log`, `/new`, and `/resume`, including concise descriptions. The menu filters as the user types and supports pointer selection, `ArrowUp`, `ArrowDown`, `Enter`, and `Escape` without taking focus away from the composer. It uses semantic surfaces, borders, text, selection, and focus tokens in both themes and remains within the System Helper Chat width on mobile.

`/log` downloads one Markdown document containing the current server transcript and visible Skill-call details; it does not append the document to the conversation, call the model, or create a server record. `/new` archives the active execution identifier and opens a blank session while leaving all workspace resources unchanged. `/resume` opens the execution history selector. Commands are trimmed and case-insensitive, and the panel remains open after execution.

## Accessibility And Themes

Use semantic surface, border, text, brand, and status tokens in both light and dark modes. Persimmon indicates the primary action, current selection, or active execution only. Messages use neutral surface contrast and speaker labels rather than color alone.

All icon-only controls require accessible names and tooltips. Send and Stop retain the same stable target dimensions and expose distinct localized accessible names. Conversation and Skill-call status changes use restrained live-region announcements. Keyboard focus remains in the editable composer after cancellation, history selection, and automatic execution updates. Reduced-motion mode replaces spinner motion with the same static working cue.

## Changelog

### 2026-08-27

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
