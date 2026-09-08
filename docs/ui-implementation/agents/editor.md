# Agent Editor

## Layout

The initial draft editor context bar contains a breadcrumb with a leading back action, save state, and one `Save` action. Saved custom Agents also expose a destructive delete icon with a tooltip and confirmation dialog; the action is absent for new and protected system Agents. Do not show Preview, Publish, version history, or execution controls until those behaviors have real end-to-end API and runtime support. The main column contains name, responsibility, and persisted system instructions.

The configuration region contains one namespaced Model selector, Skills, and MCP servers. Each model option uses `providerName/modelId` as both its displayed label and selected value. The API resolves the Provider name to its internal Provider id when saving the Agent binding; public model values and Gateway requests never expose that internal id. Provider and model choices come only from configured workspace data. Skills and MCP servers come from their real workspace collections and use controlled checkboxes; every selection belongs only to the current Agent draft. Render each assignment section as a responsive two-column list of single-line rows. Resource names truncate within their row and expose the complete name on hover or keyboard focus; keep meaningful version, connection, or validation metadata visible inline without preventing draft assignment. Loading, failure, and empty states remain local to each resource section, and an empty section links to the relevant creation page.

Saved custom Agents have an unframed execution region below the draft fields. It contains the conversation transcript, a compact prompt composer, and durable request errors. Execution is unavailable until the Agent has a configured Provider and model. Text responses use the shared streaming Markdown presentation when streaming is available; the initial terminal-tool increment may return completed turns while preserving the same message hierarchy. A submitted turn immediately creates an Agent working placeholder in the transcript. While it is running, the prompt remains editable without queuing, and the Send action becomes Stop. Cancellation preserves the draft, marks the turn and active Skill call as cancelled, and leaves the session available for another message.

When the model requests an assigned Skill's `skill_script`, append a compact inline disclosure row showing the Skill name, script name, automatic execution status, and exit code when available. The row remains collapsed by default, including for failures. Expanding it reveals the exact script path, argument list, working directory, host-execution warning, and preformatted output in a height-bounded internal scroller. The `terminal-command` Skill is represented as `scripts/run.sh` with its command string as the sole argument; it has no separate terminal tool presentation. Skill calls have no permission, `Run`, `Reject`, or approve-all control. The row exposes execution, exit, cancellation, and failure states with non-color labels, and raw output is never rendered as HTML. This automatic Agent execution path is separate from the direct Skill-editor run action.

On desktop, configuration uses the existing `360px` inspector. Below the desktop breakpoint, render the same controls inline after the main fields so configuration never disappears. Both presentations use the same draft state and semantic tokens rather than duplicate state ownership.

The protected System Helper Chat entry uses the same editor route in restricted system mode. Name, responsibility, prompt, Skills, and MCP settings are read-only product configuration; Preview, Publish, duplication, and deletion actions are absent. Show `worklite-platform` as a compact read-only built-in capability with no checkbox, remove action, or empty state. Its editable control is one namespaced Model selector populated from configured Gateway providers, including an explicit `Not configured` option. Each option uses `providerName/modelId` as its label and value; the API resolves the Provider name to the internal binding id on save. These binding controls exist only here. Deleting the selected provider removes its namespaced model option and returns the control to an unconfigured state without moving configuration into the Chat or provider surfaces.

## States

Support new unsaved, loading, saving, saved, validation failure, resource loading failure, and empty-resource states. Save errors remain visible near the action or affected configuration instead of disappearing into save-state chrome. Never expose secrets in fields or resource summaries.

## Changelog

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
