# WorkLite UI/UX Design Index

## Governance

This directory is the source of truth for page structure, shared UI architecture, implementation sequencing, and page-level acceptance criteria. `docs/ui-design-system/README.md` remains the source of truth for visual language.

Interface specifications follow the page structure rather than a flat filename list:

- Route pages use `pages/<area>/<page>/DESIGN.md`.
- Multi-page flows use `flows/<flow>/DESIGN.md`.
- Non-route surfaces use `surfaces/<domain>/<surface>/DESIGN.md`.
- Shared patterns use `shared/<topic>.md`.

Every `DESIGN.md` follows [TEMPLATE.md](TEMPLATE.md) and keeps its sections in that order. A specification records its route or surface scope, design source, implementation locations, purpose, primary task with a declared action budget, layout, per-action interaction contract, per-state behavior, copy inventory, accessibility, and coverage status. New or changed interfaces must update the affected `DESIGN.md` and this index. Do not maintain a parallel page-specification document system.

A page's Coverage Status is a verification result, not a placeholder. It states the date the document was checked against its implementation and lists the differences found.

The router supplies the shell-level pending and error boundaries through `apps/web/src/components/route-boundaries.tsx`, so a page that has not yet resolved shows a content-shaped skeleton and a page that throws shows a recoverable failure instead of an empty region. A page's own `DESIGN.md` states only what it adds beyond those defaults.

## Shared Specifications

- [Workspace shell](shared/workspace-shell.md)
- [Page patterns](shared/page-patterns.md)
- [Shared states](shared/shared-states.md)
- [Interaction contract](shared/interaction-contract.md)
- [Copy standards](shared/copy-standards.md)
- [Responsive behavior](shared/responsive-behavior.md)
- [WeChat article output](shared/wechat-article-output.md)

## Page and Surface Specifications

- [Home](pages/home/DESIGN.md), including the server-derived first-use sequence
- [Chat](pages/chat/workspace/DESIGN.md), including direct Web conversation, Channels, workspace long-term memory management and full persisted evidence
- Providers: [Model providers and Portkey Gateway](pages/model-providers/DESIGN.md), including the dedicated Codex Account Pool
- Logs: [Gateway statistics and request logs](pages/logs/DESIGN.md), including the shared time range
- Workflows: [List](pages/workflows/list/DESIGN.md), [Editor](pages/workflows/editor/DESIGN.md), [Versions](pages/workflows/versions/DESIGN.md)
- Agent Teams: work records and configuration [Detail](pages/agent-teams/detail/DESIGN.md), [Run detail](pages/agent-team-runs/detail/DESIGN.md)
- Runs: [Detail](pages/runs/detail/DESIGN.md), [Node logs](surfaces/workflow-run/node-logs/DESIGN.md)
- Skills: [List](pages/skills/list/DESIGN.md), [Editor](pages/skills/editor/DESIGN.md)
- MCP servers: [List](pages/mcp-servers/list/DESIGN.md), [Configuration](pages/mcp-servers/configuration/DESIGN.md)
- Plugins: [List](pages/plugins/list/DESIGN.md), [Configuration](pages/plugins/configuration/DESIGN.md), excluding communication-channel setup, which lives in Chat
- External chat: [Feishu](surfaces/external-chat/feishu/DESIGN.md), including native streamed reply cards, collapsed task details, capability updates and user-requested managed redeployment
- Artifacts: [Run artifacts](surfaces/workflow-run/artifacts/DESIGN.md), [Details](pages/artifacts/details/DESIGN.md)
- Settings: [Usage](pages/settings/usage/DESIGN.md), [Audit log](pages/settings/audit-log/DESIGN.md), [Appearance](pages/settings/appearance/DESIGN.md)

## Route Map

```text
/home
/chat
/model-providers
/logs
/agent-teams/:teamId
/agent-team-runs/:runId
/workflows/{new,:workflowId,:workflowId/versions}
/skills/{new,:skillId}
/mcp-servers/{new,:serverId}
/plugins
/plugins/:pluginId
/artifacts/:artifactId
/runs/:runId
/settings/{usage,audit-log,appearance}
```

The root route opens Chat. `/home` remains a retained direct route for old links but is no longer a navigation destination. `/settings/` opens Appearance. Route layouts and redirects are governed by the shared Workspace shell rather than separate page specifications.

There is no `/onboarding` route family. First use is a server-derived sequence inside Home, so a separate browser-state onboarding flow would duplicate it with a less reliable completion signal.

The `/model-providers` page is the top-level Providers destination. It uses page-level tabs for Model Providers and the dedicated Codex Account Pool; the Gateway summary remains on the Model Providers view. Activating a Provider opens its scoped statistics and recent requests in a detail dialog, while Codex authorization and account summaries live together in the pool view.

`/logs` is the top-level Logs destination for Gateway transport observability. It uses page-level tabs for Statistics and Requests over one shared time range. Provider and model filters scope both views, model breakdowns open their matching requests, and failed Provider tests can focus the exact captured request. Providers configures what the Gateway dispatches to; Logs reads what it did.

`/agent-teams/:teamId` is the direct destination for the one built-in Agent Team and defaults to summary work records, with Configuration in a validated top tab; there is no Team collection or manual Run creation route. Chat Agent dispatch is the only task entry and binds submissions directly to Run ids. A failed managed Team document can be redelivered through its detail or download route without rerunning its producing role. `/agent-team-runs/:runId` is the immutable-version evidence destination reached from a summary record or retained Run link, not a full Run collection. `/runs/:runId` is a Workflow Run log-reading destination reached from a Workflow's Run records dialog, not a top-level collection. There is no Run list route: Runs are reached through their Workflow. Provider request observability is not a Settings page: `/settings` keeps the WorkLite-owned Usage and Audit Log read models, which are business records over Runs and resource mutations rather than Gateway transport records.

## Shared Component Inventory

Theme provider and appearance selector; application shell; router pending and error boundaries; sidebar; context bar; personal preferences menu; command menu; Chat workspace with channel-aware conversation browser; shared streaming Markdown response renderer; page heading; form controls and messages; status badge; search, filters, object rows and tables; dialogs and sheets; save indicator; inspector; resizable log panel; fixed-scale HTML/SVG Workflow diagram with a bottom inspector dock and contextual floating node picker; read-only Run execution graph with node state, edge traversal, chronological trace, and node detail dock; workflow run history dialog; node log entry with payload and activity disclosure; plugin configuration; viewers for captured request bodies, run output and artifacts; skeletons, errors, offline banner.

Domain-neutral reusable components belong in the shared UI package. Feature composition remains near its feature. Abstract only demonstrated repeated patterns.

## Implementation Sequence

1. Foundations: semantic dual-theme tokens, initial theme resolution, typography, focus, motion, controls and feedback.
2. Personal workspace shell: navigation, context bar, menus and responsive behavior.
3. Home and collections: Home states and shared collection grammar.
4. Editors and execution: Agent editor, Workflow graph editor, Workflow run history, logs and artifacts.
5. Integrations and preferences: Skills, MCP servers and Settings.

Every phase includes both themes, keyboard behavior, loading and failure states.

## Changelog

### 2026-10-16 - Chat summary visibility

- The [Chat](pages/chat/workspace/DESIGN.md) `/summarize` command now leaves a visible trace: the server persists a user echo of the command before the summary divider, and a divider carrying the summary text offers an expand toggle that reveals the full summary in place; a divider without content stays a plain marker.

### 2026-10-15 - Chat /summarize command

- The [Chat](pages/chat/workspace/DESIGN.md) composer `/summarize` command summarizes the current conversation in place (`POST /chat/conversations/:id/summarize`): the server replaces the execution's model context with the generated summary and appends a persisted summary divider to the transcript, so the reader continues in the same conversation without navigation while earlier history stays visible above the divider.
- The summarize prompt becomes configurable: the settings Dialog's Configuration section gains an optional 总结提示词 textarea (empty restores the built-in default), saved through the existing revision-checked Chat configuration channel; the server uses a configured value verbatim as the summarize system prompt.

### 2026-10-13 - Team records and parallel Runs

- Team defaults to Records with linked Run progress, retains Configuration, and has no conversation or manual launch entry. Chat Agent dispatches directly to Runs. Records include Runs waiting for a parallel slot; `maxConcurrentRuns` defaults to 3 and controls FIFO queueing.
- Run detail documents the Worktree Manager stage and immutable worktree path and branch evidence.

### 2026-10-13 - Markdown for agent-authored text

- Run detail task progress, questions, outcomes and documents, plus Chat project task questions, render through the shared safe Markdown renderer.

### 2026-10-13 - Chat image attachments

- The [Chat](pages/chat/workspace/DESIGN.md) transcript renders attachment images inline and shows an expired placeholder for missing or expired ones. Adds the `assistant:attachment.expired` copy key; no new token.

### 2026-10-13 - Stable Chat settings Dialog

- The [Chat](pages/chat/workspace/DESIGN.md) settings Dialog keeps one fixed height across its Channels, Configuration and Memories sections and scrolls section content internally with a stable scrollbar gutter, so switching sections no longer resizes or shifts the Dialog. Configuration no longer offers Skill or MCP server selection; its copy keys are removed. No new token.

### 2026-10-12 - Chat long-term memory

- The [Chat](pages/chat/workspace/DESIGN.md) settings Dialog gains a Memories section listing saved workspace long-term memories with per-entry deletion and a `view=memories` deep link; saving and correcting memories happens in conversation through the protected platform tools.

### 2026-10-10 - Task progress visualization and Planner-decided Developers

- The [Chat](pages/chat/workspace/DESIGN.md) project task disclosure gains a server-derived stage chip and grouped foldable Markdown streaming with on-demand full history; Team task cards show phase and completion percentage, and a settled Chat-dispatched Team Run is reported once by an automatic reply. The [Team](pages/agent-teams/detail/DESIGN.md) configuration removes the Developer instance list and concurrency bound (the Planner decides 1-4 parallel lanes per Run), and the [Run detail](pages/agent-team-runs/detail/DESIGN.md) progress header gains a percentage bar while member output groups deltas per task attempt. [Feishu](surfaces/external-chat/feishu/DESIGN.md) Team cards carry the same phase and percentage.

### 2026-10-09 - Visible Chat question answers

- The [Chat](pages/chat/workspace/DESIGN.md) transcript keeps answered questions as a question line plus a user answer message, shows a submitted answer immediately, and restores it to the composer when it is rejected. No new token or copy key.

### 2026-10-09 - Independent Chat task feedback

- The [Chat](pages/chat/workspace/DESIGN.md) task region retains public executor progress text, failed dispatches and separately observed Team status, failures and pending questions. Existing task links and dual-theme semantic components remain the interaction surface.

### 2026-10-09 - Deployment-backed development data

- Updated the [Providers](pages/model-providers/DESIGN.md) Gateway summary to display deployment listener `23392` because development no longer starts a separate Gateway.

### 2026-10-09 - Chronological Chat transcript

- The [Chat](pages/chat/workspace/DESIGN.md) transcript orders every entry, including task cards and failed dispatches, by its own timestamp; unfinished execution cards scrolled above the view appear as compact rows in a pinned bar. The project task disclosure names its executor instead of a `cx`/`cxo` launch mode.

### 2026-10-08 - Bounded Codex operation evidence

- Keep activity and operation summaries compact in the Chat transcript, with the latest operation detail loaded on demand and a control-local retry when that read fails.

### 2026-10-08 - Chat Codex evidence readability

- Structured the [Chat](pages/chat/workspace/DESIGN.md) Codex task disclosure: the collapsed row carries goal, status, directory, model/launch mode and latest persisted activity, while expansion shows metadata, bounded activities and journaled operations, Markdown result, red failure text, and a secondary raw-JSON disclosure.

### 2026-10-08 - Lively visual direction

- Applied the new lively design-system direction to shared components: shared motion tokens, trigger-width field overlays, single-line truncation, sliding tabs, shimmer skeletons, and unified status components.
- Updated the [Workspace shell](shared/workspace-shell.md), [Shared states](shared/shared-states.md), and [Chat](pages/chat/workspace/DESIGN.md) specifications for live-work grouping, status presentation, and shell geometry.

### 2026-10-08 - User-requested Chat redeployment

- Sending an explicit redeploy request is the single activation in Web and Feishu; persisted deployment progress uses the existing conversation task region, with no confirmation or refresh control.

### 2026-10-08 - Chat-first navigation and settings Dialog

- Redirected the root route to Chat and removed Home from sidebar and command-menu destinations while retaining `/home` as a direct route.
- Replaced Chat's internal three-tab body with a conversation-only workspace, hid its shell search, and moved Channels and Configuration into an accessible URL-backed settings Dialog.

### 2026-10-08 - Chat orchestration and stable conversation updates

- Restrict Web and Feishu Chat to protected platform operations and delegated execution; Skill/MCP selections configure its Codex executor. Preserve historical evidence and recovery.
- Keep conversation content and composer stable across active status changes and event replay in both themes.

### 2026-10-08 - Chat cancellation and shared Codex execution

- Compose Tooltip and Send/Stop click handlers so wrapper props cannot replace cancellation.
- Keep Cancel available while Chat runs or waits for an ordinary answer, with control-local progress and retained evidence. Sending/answering does not block Cancel; snapshot loading does not invalidate mutation cleanup.
- Chat Codex and Team developer use one direct executor without WorkLite authorization; direct Shell and non-Codex Team grants remain separate.
- Team conversation, Run detail and Feishu developer questions omit obsolete command-grant inputs.

### 2026-10-07 - Retired Chat question recovery

- Automatically retire obsolete unstarted Shell questions and unblock normal dialogue while retaining history and explicit recovery for reserved effects.

### 2026-10-07 - Chat task confirmation

- Replaced Chat per-command fields with one proposal confirmation in the existing answer region, shared by direct Shell and Chat Codex tasks. Team command forms are unchanged.

### 2026-10-07 - Chat direct Shell

- Reused Chat and Feishu command authorization, recovery and execution disclosures for conversation-owned Shell calls independent of Codex and Team.

### 2026-10-07 - Chat Codex execution

- Added a request-bound new-conversation button after Agent intent recognition, absent from ordinary replies.
- Extended Chat and Feishu conversation specifications with independent Codex task progress, exact-command answers and uncertain-effect recovery; no new route or navigation destination.

### 2026-10-06 - Feishu native card presentation

- Defined native typewriter replies, independent status/body updates and collapsed Team/Workflow execution details in the Feishu surface; kept question and recovery actions visible.

### 2026-10-05 - Resuming cancelled Runs

- Updated the Run Detail contract so resume visibility follows the server-owned `resumable` flag for paused Runs and scheduler-state-backed cancelled Runs.

### 2026-10-04 - Chat workspace

- Replaced the embedded Chat Bot specification with the `/chat` page, Web channel, Feishu channel configuration, server-owned conversation history and complete stored evidence.

### 2026-10-04

- Refined Feishu chat to natural dialogue with current-question options, same-card loading and no persistent mode menu.

- Added Feishu external-chat specification, independent plugin configuration, and shared Chat Bot task dispatch.

### 2026-10-03 - Agent Team interaction and role configuration

- Embedded the default removable Coordinator target in the Team composer and collapsed empty contextual side space.
- Reworked role settings into a compact model-first list with provider-grouped choices and role-local advanced disclosure.

### 2026-10-03 - Provider and model observability

- Added Provider-scoped activity details and consolidated the Codex account summary with its pool.
- Added shared Provider/model statistics filters, model-to-request drill-down, and exact request focus from Provider tests.

### 2026-10-03

- The 2026-10-13 correction replaces the Team conversation with work records and keeps role setup under Configuration; Chat Agent owns new Run dispatch.
- Added durable Coordinator intake, automatic Run creation, concise conversation execution state, delivered Team document files, contextual viewing, download, and a conversation-origin return link on Run evidence.
- Removed the form-first Team launch behavior without retaining a compatibility alias.

### 2026-10-03

- Added direct built-in Agent Team and Team Run detail routes with structured authorization, recovery and replayable observation.


### 2026-09-24 - Run execution graph

- Added a read-only immutable-version graph to expanded Run records and Run detail, with a chronological trace for node invocations and edge decisions.
- Kept per-node input, activity, output, failure, and retry details in the selected-node dock.

### 2026-09-23 - Contextual Workflow node picker

- Removed the idle node palette from the Workflow editor's right panel; the inspector appears only for selected graph items.
- Added a floating picker for independent node additions and compatible targets dropped onto blank canvas.

### 2026-09-23 - Workflow bottom inspector

- Placed selected Workflow node and edge configuration below the diagram at every breakpoint, keeping the diagram full height when nothing is selected.

### 2026-09-23 - WeChat article output

- Added the shared Mint Cyan article-body contract for heading hierarchy, paragraph indentation, neutral content blocks, code, and creative same-family tables.

### 2026-09-23 - Compact Workflow flow view

- Updated the [Workflow Editor specification](pages/workflows/editor/DESIGN.md) for compact stage nodes, concise route labels, selection path emphasis, reduced-motion directional feedback, and explicit draft alignment.

### 2026-09-23 - Workflow canvas navigation

- Made existing Workflow graphs open in a left-to-right dependency layout, with the viewport fitted after graph hydration, horizontal wheel panning, and two-axis canvas dragging.
- Kept saved graph coordinates and save state unchanged on open; manual node movement remains a draft edit.

### 2026-09-23 - Workflow coordinate layout

- Defined `x` from dependency rank and `y` from symmetric lanes, with mean incoming-source topological order and graph definition order providing stable parallel-node placement.
- Recalculate the complete layout whenever nodes or edges are added, removed, connected, or reconnected.

### 2026-09-23 - Workflow diagram navigation

- Replaced the React Flow canvas with a fixed-scale HTML/SVG diagram and native horizontal and vertical scrolling.
- Kept automatic dependency layout, graph selection, port connections, conditional edges, and bounded feedback while removing canvas zoom, pan-dragging, node dragging, and manual alignment.

### 2026-09-23 - Chat Bot response loading

- Deferred the shared Markdown renderer until the Chat Bot transcript is visible, keeping the collapsed Home transcript mounted and response text readable while the renderer loads.

### 2026-09-23 - Home Workflow output links

- Updated the [Home](pages/home/DESIGN.md) contract so rows use a top-level `url` from the Dashboard output when the layout has no explicit URL field.

### 2026-09-22 - Run pause and resume

- Added reversible Run pause and resume controls to the Run Detail acceptance contract, with a warning paused status and control-local feedback.
- Extended Run cancellation eligibility to paused Runs and documented paused execution as active reversible state.

### 2026-09-22 - Workflow execution freshness

- Added automatic five-second refresh to the mounted Workflow List so server-observable latest-run state stays current without a manual refresh action.
- Made the Workflow editor enter `/runs/:runId` after starting a Run, reusing the existing live Run detail surface for execution progress.

### 2026-09-21 - Chat Bot interaction pass

- Moved the Chat Bot surface specification from `surfaces/workspace/system-helper-chat/` to `surfaces/workspace/chat-bot/`, matching the product name the surface has used since the System Helper rename.
- Reversed the omission of Chat Bot message queuing: a message submitted during a running turn enqueues into a visible removable FIFO queue instead of being silently discarded, and pauses on failure, on stop, and while a clarification is pending.
- Defined per-press `Escape` layer dismissal, one identity block per Chat Bot turn with Skill calls inside it, a searchable modal `/resume` session selector, and transcript stickiness with a return-to-end control.
- Removed the redundant `system-helper-chat` Chat Bot navigation target, which resolved to the same `/home` route as `home` and gave the model two enum values for one destination.

### 2026-09-21 - Logs destination

- Added the [Logs](pages/logs/DESIGN.md) destination at `/logs` as a first-level navigation item under Configuration, with Statistics and Requests as its two page-level tabs.
- Moved the Gateway Statistics and Gateway Request Logs views off the Providers destination. Providers keeps Model Providers and the Codex Account Pool, so Providers configures dispatch while Logs reads it. This supersedes the 2026-09-21 decision that Provider request observability lives with Providers.
- Added one time range shared by both tabs: the presets last 1 hour, 24 hours, 7 days, and 30 days, plus a custom minute-precision start and end that expresses a specific date or a span of hours within one day. A preset persists as its own name and a custom range as absolute instants, so a shared preset link is not frozen into a dead interval.
- Recorded the retention asymmetry as a Constraint on the Requests tab: statistics cover any range, request details cover at most the trailing three days of it, and a range reaching past that window says so rather than reading as an absence of requests.
- Redirected both inbound observability links to the new destination: the node log's `View request logs` and the failed provider test's `View request log`.

### 2026-09-23 - TypeSafe System One Map node

- Updated the [Workflow Editor specification](pages/workflows/editor/DESIGN.md) for the per-element `typesafe/systemone-map@1` node, including its shared state port, items and context paths, concurrency bound, and progressively disclosed ranking controls.

### 2026-09-22 - JSON Choice Branch

- Updated the [Workflow Editor specification](pages/workflows/editor/DESIGN.md) for the generic `worklite/branch@1` node, which routes any JSON output through the first matching structured edge condition and does not depend on System One.

### 2026-09-22 - TypeSafe System One Workflow node

- Updated the [Workflow Editor specification](pages/workflows/editor/DESIGN.md) for the dedicated `typesafe/systemone@1` node, including its state input, preserved object context, typed-answer output, model selector, and structured questions editor.

### 2026-09-20 - Run cancellation

- Added the active Run cancellation action to the Run detail surface, using the existing cancellation API and shared confirmation interaction.

### 2026-09-21 - Workflow and Provider log surfaces

- Added the [Run detail](pages/runs/detail/DESIGN.md) route and the shared [node log](surfaces/workflow-run/node-logs/DESIGN.md) surface, which discloses a node's mapped input, committed output, streamed model text, and ordered activity timeline from one expansion in both the Run records dialog and the Run detail route.
- Added the Gateway Request Logs view to the Providers destination for reading what an individual Provider request sent and received, with filters persisted together in route Search state.
- Removed the Diagnostic Logs page, its `/settings/logs` route, and its locale keys; Provider request observability is now Gateway-owned and lives with Providers.

### 2026-09-19 - State completeness

- Added shell-level router pending and error boundaries so an unresolved or failed route shows a content-shaped skeleton or a recoverable failure rather than an empty region.
- Resolved the state gaps recorded for Artifact details, Workflow versions, MCP server configuration, and Appearance: detail routes now separate loading, not-found, and load failure; placeholder columns and false success feedback are gone.
- Removed the `/onboarding` implementation together with its routes, locale namespace, browser-state store, and mock resource fixtures.

### 2026-09-19

- Added the [interaction contract](shared/interaction-contract.md): one activation point per goal, server-observable staleness recovered without a manual control, declared per-page action budgets, control-local feedback, and silently reapplied remembered input.
- Added [copy standards](shared/copy-standards.md): text must be an action, a state, a constraint, or a recovery, and text made obsolete by automation is removed in the same change.
- Added [TEMPLATE.md](TEMPLATE.md) and rewrote every page and surface specification against it, replacing the uniform unaudited Coverage Status placeholder with dated verification results and concrete difference lists.
- Removed the `/onboarding` route family and its specification. Home already derives first-use completion from persisted server resources, so the browser-state flow was an unreachable duplicate with a weaker completion signal.

### 2026-09-18
- Added per-node retry to expanded Workflow Run records: the server marks the single retryable failed node entry, its neutral control reports progress locally, failure reasons persist until execution continues, and no Run-level rerun action is introduced.
- Updated the Workflow Editor specification for the read-only Artifact Query node, historical title/description field controls, and conditional initial Agent context alongside bounded feedback. The existing shared patterns and design tokens remain authoritative.

### 2026-09-17
- Documented the Workflow Image node, constrained generation inspector, and required generated-cover connection for the WeChat Official Account node.
- Documented explicit Workflow Input-to-Agent context edges that may coexist with one bounded feedback edge.

- Replaced `docs/ui-implementation/` with the root-level `ui-ux-design/` structure required by the project documentation convention.
- Moved every page and surface specification into a directory-specific `DESIGN.md`, added route/source/implementation/coverage metadata, and retained shared specifications under `ui-ux-design/shared/`.
- Added the Plugin List route to the route map.

### 2026-09-16

- Made Workflow List latest-run statuses interactive for every status so any latest run opens its matching Run records dialog.
- Added resumable Workflow pending actions, WeChat QR authentication in Run records, and the WeChat Official Account Plugin configuration surface.

### 2026-09-15

- Added published Workflow mentions to the embedded chat, including keyboard selection, version-bound Run progress, cancellation, failure feedback, and Artifact links.
- Updated the development Web, API, and Portkey Gateway ports to `3390`, `3391`, and `3392` while leaving local deployment ports unchanged.
- Added the Workflow Artifact node and removed implicit Agent file-output controls while preserving inline Run Artifact disclosure and direct Artifact details.
- Consolidated Workflow list actions by removing the Steps and Run records columns, moving Run records into Actions, removing direct table deletion, and making failed latest-run status open the matching Run record.
- Made Home board rows with configured HTTP(S) URL values open the item URL in a new browser tab.
- Removed the standalone Runs routes and navigation destination; Workflow run records remain accessible from Workflow List and the Workflow editor.
- Added a shared lightweight configuration-panel pattern for embedded Agent settings.

### 2026-09-14

- Refined Home board and category behavior around Workflow Dashboard output.
- Added resumable Chat Bot sessions and slash-command completions.

### 2026-09-13

- Refined Workflow version actions and run-history behavior.

### 2026-09-12

- Added Workflow Input and Skill Set graph nodes and refined the persisted workflow canvas.

### 2026-09-11

- Expanded Model Providers with the Codex Account Pool and Gateway request statistics.

### 2026-09-10

- Refined workspace navigation and model-binding controls.

### 2026-09-09

- Added shared Plugin configuration behavior and WeChat connection surfaces.

### 2026-09-08

- Refined Workflow list and version-state behavior.

### 2026-09-07

- Refined Workflow editor layout and run-history surfaces.

### 2026-09-06

- Expanded shared status, table, dialog, inspector and log-panel behavior.

### 2026-09-05

- Refined workspace shell navigation and command behavior.

### 2026-09-04

- Added Provider protocol and Gateway administration controls.

### 2026-09-03

- Expanded skills, MCP servers, artifacts and settings specifications.

### 2026-09-02

- Fixed the Portkey Gateway view to display the non-editable loopback port `4547` and removed port configuration controls.
- Added the Settings Diagnostic Logs page for trace-oriented Provider connection troubleshooting.
- Defined a dedicated `/settings/logs` route alongside Audit Log, with filtering and expandable event details.

### 2026-08-31

- Expanded the workflow graph component inventory with Workflow Input, Skill Set, and named-port Generic Agent nodes.
- Replaced the ordered Workflow editor component inventory with the persisted workflow graph canvas.
- Restored the `@xyflow/react` canvas implementation and removed the minimap from the workflow editor.

### 2026-08-30

- Moved Skills, MCP Servers, and Providers from the sidebar subgroup into shared tabs on the four resource collection pages; Plugins remains first-level navigation.
- Unified workspace and Agent resource navigation into one hierarchical sidebar, with Plugins beside Agents and Skills, MCP Servers, and Providers beneath Agents.

### 2026-08-27

- Reduced the Home first-use checklist to Model Provider configuration and Chat Bot model binding, with completion derived from persisted resource state.
- Removed the standalone Terminal page; direct host execution is now an action on saved Skill scripts in the Skill editor.

### 2026-08-29

- Added the shell-owned plugin picker for the built-in Codex CLI Chat plugin. Activation changes the execution target while preserving the existing transcript, streaming, cancellation, and error presentation patterns.
- Added Plugins as an Agent-surface resource view with a dedicated Codex CLI configuration page, persisted command editing, server-side availability testing, and responsive save/error states.

### 2026-08-26

- Added the shared streaming Markdown response renderer to the component inventory.

### 2026-08-25

- Replaced the authenticated team route map with a single-user personal workspace route map.
- Removed account, invitation, team setup, member administration, team switcher, and team access-state requirements.
- Moved collection creation controls for Agents, Skills, MCP Servers, and Model Providers into the right side of the toolbar directly above each table or list.
- Added explicit Model Provider creation and confirmed deletion flows while preserving write-only credentials.

### 2026-08-24

- Kept Model Providers on a dedicated top-level route while placing it as the final page-level view in the Agents surface.

### 2026-08-20

- Moved embedded Agent Chat ownership to the workspace shell so sessions survive page navigation in browser memory.
- Merged Agent Chat into Home as an expandable workspace above a persistent composer.

### 2026-08-13

- Replaced the monolithic implementation specification with an indexed set of shared and page-specific documents.
