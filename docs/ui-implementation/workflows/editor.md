# Workflow Editor

## Model

The workflow editor presents a directed acyclic dataflow graph. The first-party palette includes Workflow Input, Text, Skill Set, and Generic Agent nodes. Workflow Input exposes the run input. Text is an editable constant source used for system prompts. Skill Set selects explicit workspace Skills. Generic Agent references one immutable AgentVersion and has named `context`, `systemPrompt`, and `skills` inputs plus one output. One output may fan out to multiple downstream nodes, while each named input accepts at most one edge. Conditions, loops, dynamic joins, and parallel execution are unavailable.

## Layout and Interaction

The context bar contains breadcrumb, saved state, revision history, Run where valid, and Publish. The editor workspace has a node palette, a central `@xyflow/react` canvas, and a contextual inspector. The canvas supports node dragging, handle-to-handle connection, edge selection and deletion, panning, wheel or pinch zoom, zoom controls, and fit-to-view. It intentionally does not render a minimap. On smaller breakpoints the palette and inspector become drawers or sheets without removing their actions. An optional AI assistant panel accepts instructions and presents reviewable structured operations. A bottom panel shows test output, logs and artifacts.

The creation flow offers a blank workflow or a starter template, then collects the workflow name and initial input. The node palette adds a node near the center of the current viewport. Each node shows its type, AgentVersion context when applicable, named handles, error policy, validation and execution state. Text nodes contain an inline React textarea and a matching inspector field. Skill Set nodes use the inspector to select Skills and show the selected names on the canvas. Generic Agent nodes show separate left-side handles for context, system prompt, and Skills so composition remains visible at normal zoom. Selection reveals duplicate and remove commands in the inspector. Edge selection reveals endpoints and a remove command. Pointer dragging is not required to review configuration or remove graph objects.

Starter templates are assembled only from real workspace resources. Generic Agent choices without an immutable version remain unavailable and explain that the Agent must be published first. Skill Set choices come only from real workspace Skills. Run targets the latest published version, is unavailable while the draft has unsaved changes, and labels that version boundary explicitly. The output panel contains only persisted output from a selected run; it does not show seeded logs. AI editing controls appear only when a server-backed proposal operation exists and never simulate an applied edit.

Workflow-level settings are grouped into General, Inputs, Execution, and Versioning sections. General contains the workflow name and publication metadata; Inputs contains the input editor and examples; Execution contains default error policy and runtime defaults; Versioning contains draft, revision and publication context. Keep advanced settings collapsed until requested.

Connect nodes with quiet directional edges. Persimmon indicates selection and current execution; semantic markers indicate completion and failure. Port labels and accessible names identify context, prompt, Skill, and output semantics without relying on color. Invalid or type-incompatible connection attempts leave graph state unchanged. File outputs link to Artifacts. AI edits show instruction, operations, resulting revision and undo. Publication validates acyclicity, port rules, locked Agent versions, Skill availability, and per-Agent Skill authorization.

## Changelog

### 2026-08-31

- Added Workflow Input, Skill Set, and Generic Agent node presentation with named context, system-prompt, and Skill ports.
- Made reusable prompts and Skill authorization visible as graph connections while retaining sequential execution and one edge per input port.
- Replaced the fixed ordered sequence with an `@xyflow/react` DAG canvas supporting persisted layout, explicit edges, data fan-out, panning, zooming, fit-to-view, and a minimap.
- Added inline Text editing and contextual node and edge configuration while deferring conditions, joins, loops, and parallel execution.
- Restored the `@xyflow/react` implementation and removed the minimap while retaining the same graph contract.

### 2026-08-29

- Removed simulated templates, AI edits and run logs from the editor contract; required real workspace AgentVersions, explicit published-version Run behavior and persisted output only.

### 2026-08-29

- Defined the first-phase ComfyUI-inspired workspace layout, creation flow, agent palette, grouped settings, and responsive inspector behavior while retaining linear execution.
- Extended the editor model to generic Text and Agent nodes with immutable AgentVersion and file Artifact context.

### 2026-08-13

- Established the ordered-step Workflow Editor specification.
