# Agent Editor

## Route

`/agents/{new,:agentId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/agents/$agentId.tsx`

## Purpose

Define what an Agent is — its instructions, its model, and the Skills and MCP servers it may use — and run it.

## Primary Task

Persist the Agent draft. Action budget: one — `Save`. Every field and assignment edits the same draft, and `Save` commits all of them together.

Running the Agent is a separate goal with its own budget of one — `Send`. Execution is an independent intent: it does not persist configuration and configuration does not require it. Creating an immutable version is likewise its own action, because a version is an irreversible snapshot.

## Layout

The context bar contains a breadcrumb with a leading back action, save state, and one `Save` action. Saved custom Agents also expose a destructive delete icon with a tooltip and confirmation dialog; the action is absent for new and protected system Agents. Do not show Preview, Publish, version history, or execution controls until those behaviors have real end-to-end API and runtime support. The main column contains name, responsibility, and persisted system instructions.

The configuration region contains one namespaced Model selector, Skills, and MCP servers. Each model option uses `providerName/modelId` as both its displayed label and selected value. The API resolves the Provider name to its internal Provider id when saving the Agent binding; public model values and Gateway requests never expose that internal id. Provider and model choices come only from configured workspace data. Skills and MCP servers come from their real workspace collections and use controlled checkboxes; every selection belongs only to the current Agent draft. Render each assignment section as a responsive two-column list of single-line rows. Resource names truncate within their row and expose the complete name on hover or keyboard focus; keep meaningful version, connection, or validation metadata visible inline without preventing draft assignment. Loading, failure, and empty states remain local to each resource section, and an empty section links to the relevant creation page.

Saved custom Agents have an unframed execution region below the draft fields. It contains the conversation transcript, a compact prompt composer, and durable request errors. Execution is unavailable until the Agent has a configured Provider and model.

On desktop, configuration uses the existing `360px` inspector. Below the desktop breakpoint, render the same controls inline after the main fields so configuration never disappears. Both presentations use the same draft state and semantic tokens rather than duplicate state ownership.

The protected System Helper Chat entry uses the same editor route in restricted system mode. Name, responsibility, and prompt are read-only product configuration; MCP settings are editable through a multi-select list of configured workspace MCP servers; Preview, Publish, duplication, and deletion actions are absent. Show `worklite-platform` as a compact read-only built-in capability with no checkbox, remove action, or empty state. Its editable control is one namespaced Model selector populated from configured Gateway providers, including an explicit `Not configured` option. Each option uses `providerName/modelId` as its label and value; the API resolves the Provider name to the internal binding id on save. These binding controls exist only here. Deleting the selected provider removes its namespaced model option and returns the control to an unconfigured state without moving configuration into the Chat or provider surfaces.

## Interaction Contract

`Save` reports progress on itself, commits name, responsibility, instructions, model binding, and both assignment sets, then settles the save indicator at `Saved`. A new Agent navigates to its own route on first save without losing draft state. Failure returns the indicator to `Unsaved changes` and states the reason near the action; a missing name reports on the name field itself rather than as a general save error. Editing any field marks the draft unsaved and clears the previous save error.

`Create version` is available only for a saved custom Agent with no unsaved changes, because a version snapshots persisted state. It reports progress on itself and confirms with a toast, since the created version is immediately visible in the version list.

In the execution region, submitting a message immediately creates an Agent working placeholder in the transcript. While a turn is running the prompt remains editable without queuing, and the `Send` action becomes `Stop`. Cancellation preserves the draft, marks the turn and active Skill call as cancelled, and leaves the session available for another message. Text responses use the shared streaming Markdown presentation when streaming is available; the initial terminal-tool increment may return completed turns while preserving the same message hierarchy.

Transcript updates arrive on the Agent execution event stream while the execution is `running` or `waiting_for_input`. A dropped stream reconnects on its own without resubmitting the user message, per `shared/interaction-contract.md`. There is no manual refresh control for the transcript.

When the model requests an assigned Skill's `skill_script`, append a compact inline disclosure row showing the Skill name, script name, automatic execution status, and exit code when available. The row remains collapsed by default, including for failures. Expanding it reveals the exact script path, argument list, working directory, host-execution warning, and preformatted output in a height-bounded internal scroller. The `terminal-command` Skill is represented as `scripts/run.sh` with its command string as the sole argument; it has no separate terminal tool presentation. Skill calls have no permission, `Run`, `Reject`, or approve-all control. The row exposes execution, exit, cancellation, and failure states with non-color labels, and raw output is never rendered as HTML. This automatic Agent execution path is separate from the direct Skill-editor run action.

Delete keeps its own confirmation, per the permanent-removal exception in `shared/interaction-contract.md`. Successful deletion returns to the Agent list. The System Helper Agent never exposes deletion.

## States

| State | Behavior |
| --- | --- |
| Loading | Existing Agents show field-shaped skeletons for name, responsibility, and instructions inside a `role="status"` live region. Each resource section shows its own local loading message rather than blocking the form. The version list shows row-shaped skeletons. |
| Empty | An empty Skills or MCP section explains the resource and links to its creation page. An Agent with no versions states that plainly. An execution region with no turns shows only the composer. |
| No results | Not applicable; this surface has no filtering. |
| Error | A failed Agent load replaces the form with `ErrorState` and a retry. Save failure stays near the action; validation failure stays on its field. Each resource section reports its own failure locally with a retry where one exists, preserving the rest of the form. |
| Busy | `Save`, `Create version`, `Send`, and `Stop` each report on themselves. A running turn keeps the composer editable and does not disable configuration. |
| Offline | Inherits `shared-states.md`. The execution stream resumes without duplicating a submitted message. |
| Long content | Instructions use a tall monospace editor. Truncated resource names expose their complete value. Skill-call output uses a height-bounded internal scroller. |

Support new unsaved, loading, saving, saved, validation failure, resource loading failure, and empty-resource states. Save errors remain visible near the action or affected configuration instead of disappearing into save-state chrome. Never expose secrets in fields or resource summaries.

## Copy Inventory

| Key | Category |
| --- | --- |
| `agents:editor.new` | State |
| `agents:editor.fallback` | State |
| `agents:editor.name` | State |
| `agents:editor.responsibility` | State |
| `agents:editor.instructions` | State |
| `agents:editor.instructionsHint` | Constraint |
| `agents:editor.configuration` | State |
| `agents:editor.model` | State |
| `agents:editor.modelHint` | Constraint |
| `agents:editor.systemHint` | Constraint |
| `agents:editor.builtInCapabilities` | State |
| `agents:editor.skills` | State |
| `agents:editor.skillsHint` | Constraint |
| `agents:editor.mcpServers` | State |
| `agents:editor.mcpServersHint` | Constraint |
| `agents:editor.selectedCount` | State |
| `agents:editor.resourcesLoading` | State |
| `agents:editor.skillsLoadFailed` | Recovery |
| `agents:editor.mcpLoadFailed` | Recovery |
| `agents:editor.noSkills` | Recovery |
| `agents:editor.noMcpServers` | Recovery |
| `agents:editor.createSkill` | Action |
| `agents:editor.connectMcpServer` | Action |
| `agents:editor.delete` | Action |
| `agents:editor.deleteTitle` | State |
| `agents:editor.deleteDescription` | Constraint |
| `agents:editor.deleteAction` | Action |
| `agents:editor.deleteFailed` | Recovery |
| `agents:editor.deleted` | State |
| `agents:editor.nameRequired` | Recovery |
| `agents:editor.loadFailed` | Recovery |
| `agents:editor.saveFailed` | Recovery |
| `agents:editor.versions.*` | State, Action, Recovery |
| `agents:execution.title` | State |
| `agents:execution.newSession` | Action |
| `agents:execution.configureModel` | Recovery |
| `agents:execution.saveFirst` | Recovery |
| `agents:execution.placeholder` | State |
| `agents:execution.messageLabel` | State |
| `agents:execution.send` | Action |
| `agents:execution.stop` | Action |
| `agents:execution.working` | State |
| `agents:execution.requestFailed` | Recovery |
| `agents:execution.cancelFailed` | Recovery |
| `agents:execution.userMessage` | State |
| `agents:execution.agentMessage` | State |
| `agents:execution.tool.warning` | Constraint |
| `agents:execution.tool.*` | State, Action |
| `agents:notConfigured` | State |
| `agents:loading` | State |
| `agents:loadFailed` | Recovery |
| `common:actions.save` | Action |
| `common:actions.back` | Action |
| `common:actions.cancel` | Action |
| `common:actions.tryAgain` | Action |
| `common:saveState.*` | State |

`agents:editor.provider`, `agents:editor.providerHint`, `agents:editor.providerHintCustom`, and `agents:editor.noModels` are removed: the namespaced model selector replaced the separate Provider control, and none of the four is referenced by the implementation.

`agents:editor.instructionsHint` is retained as a Constraint for its second clause: that secrets must not be pasted into the prompt is not inferable from a text area. Its first clause restating that the field is a prompt editor is removed from the string.

`agents:editor.deleteDescription` and `agents:delete.description` overlap. The editor's confirmation must state the complete consequence, so the editor retains one of them and the weaker phrasing is removed rather than kept as a second variant.

## Accessibility

`Tab` reaches the back action, the main fields in reading order, the version and execution regions, then the configuration inspector; below the desktop breakpoint configuration follows the main fields inline in the same order. Every field has a visible label bound by `htmlFor`, and the name field's validation message is associated with it through its error state. Each assignment section is a `fieldset` with a `legend` and a selected count, and each checkbox carries its resource name as its accessible name. Truncated resource names expose their complete value through a tooltip reachable by keyboard focus.

The Skill-call disclosure is a `button` with `aria-expanded` and an accessible name that states whether activating it shows or hides details. Execution status, tool status, and MCP connection state each use a badge with a text label, never color alone. The transcript is a polite live region; user and Agent messages carry screen-reader-only speaker labels so alignment is not the only cue. The working placeholder is a `role="status"`, and reduced-motion mode keeps its static text cue. Icon-only controls for back, delete, and `Stop` have accessible names.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/agents/$agentId.tsx`:

- The execution event stream is skipped for system Agents (`isSystem` short-circuits the `useEffect`), so a System Helper turn opened through this route never streams and appears stalled.
- `Create version` sits in the context bar beside `Save` with no disclosure, giving the surface two adjacent commit-like primary actions; the specification treats versioning as a separate, irreversible intent that should not compete with `Save`.
- Version creation reports success and failure only through toasts, so a failure leaves nothing durable in the page, against `shared-states.md`.
- The mobile configuration section is rendered unconditionally, including during the loading and error branches, so a failed Agent load still shows a full configuration inspector below the error.
- `agents:editor.deleteDescription` describes removal of "the Agent, its assignments, and its execution history" while `agents:delete.description` names versions, schedules, and sessions as well. The editor dialog uses the weaker text for the same permanent action.
- `agents:editor.provider`, `editor.providerHint`, `editor.providerHintCustom`, and `editor.noModels` are defined but never referenced.
- The delete confirmation passes `editor.deleteAction` as its `busyLabel`, so the dialog shows no distinct busy text while deletion is in flight.

## Changelog

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding per-goal action budgets, the per-state table, the copy inventory, and verified coverage findings.
- Declared configuration, execution, and versioning as three separate intents, and required versioning not to compete with `Save` as a second adjacent primary action.
- Required the execution stream to reconnect on its own with no manual refresh, and required durable in-page feedback for version creation.
- Removed four unreferenced provider-selector keys and the duplicated weaker delete description under the new copy standards.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-09-04

- Made `providerName/modelId` the actual selected and Gateway-requested model value instead of a label over a Provider-id namespace.

### 2026-09-03

- Consolidated Agent Provider and model controls into one namespaced model selector while preserving the existing provider-id and model persistence contract.

### 2026-08-27

- Made Agent Skill calls compact and collapsed by default while retaining status and exit context in the summary and complete bounded details on demand.
- Added transcript-owned working and cancelled states, editable drafts during execution, and a server-backed Stop action for custom Agent turns.
- Kept one active turn and intentionally did not add a message queue.

### 2026-08-28

- Added confirmed deletion for saved custom Agents while keeping protected system Agents non-destructive.
- Changed Agent Skill and MCP assignment sections to responsive two-column, single-line rows with complete-name disclosure for truncated resources.

### 2026-08-27

- Replaced per-invocation Skill approval controls with automatic server execution and observer-only status, metadata, warning, and output presentation.
- Removed approval, rejection, and duplicate-decision states from the Agent execution region.

### 2026-08-27

- Unified terminal command requests with assigned Skill-script approval by representing the built-in terminal command as `terminal-command/scripts/run.sh`.
- Removed the separate `terminal_command` tool presentation and retained exact arguments, host warnings, and per-invocation approval.

### 2026-08-27

- Aligned Agent tool output with the shared uncapped Commands runtime and distinguished Agent approval from direct Skill-editor execution.

### 2026-08-27

- Generalized the Agent execution approval region for terminal commands and assigned Skill scripts.
- Required Skill name, script path, arguments, package-root working directory, snapshot boundary, and non-sandbox warning before execution.

### 2026-08-26

- Added a read-only `worklite-platform` capability summary to restricted System Helper Chat configuration without exposing Skill assignment controls.

### 2026-08-26

- Added the custom Agent execution region and the explicit per-command host terminal approval state.
- Required exact command and working-directory disclosure, non-sandbox warning, durable execution results, bounded output presentation, and no approve-all action.

### 2026-08-26

- Replaced placeholder model, Skill, and MCP choices with real workspace-backed draft configuration.
- Made Skill and MCP assignments independent per Agent and responsive across desktop and mobile layouts.
- Limited the initial surface to persisted Agent drafts and removed unsupported Preview, Publish, version, and execution controls.

### 2026-08-26

- Added restricted system mode for System Helper Chat with provider and model binding controls.
- Added a leading back action before the Agent editor breadcrumb.

### 2026-08-13

- Established the Agent Editor specification.
