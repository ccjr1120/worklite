# Workflow Editor

## Model

The initial workflow is a fixed ordered sequence of generic nodes. The first-party palette includes Text and Agent nodes. It is not a graph canvas and does not support arbitrary edges, branching, loops, parallel execution or backward jumps.

## Layout and Interaction

The context bar contains breadcrumb, saved state, revision history, Test or Preview where valid, and Publish. The editor workspace has a node palette, a central ordered sequence, and a contextual inspector. On smaller breakpoints the palette and inspector become drawers or sheets without removing their actions. An optional AI assistant panel accepts instructions and presents reviewable structured operations. A bottom panel shows test output, logs and artifacts.

The creation flow offers a blank workflow or a starter template, then collects the workflow name and initial input. The node palette supports search and explicit insertion before or after the selected node. Each node shows position, node type, AgentVersion context when applicable, input mapping summary, output type, error policy, validation and execution state, plus accessible move up, move down, duplicate and remove actions. Reordering must not depend on drag-and-drop.

Workflow-level settings are grouped into General, Inputs, Execution, and Versioning sections. General contains the workflow name and publication metadata; Inputs contains the input editor and examples; Execution contains default error policy and runtime defaults; Versioning contains draft, revision and publication context. Keep advanced settings collapsed until requested.

Connect nodes with a quiet timeline. Persimmon indicates selection and current execution; semantic markers indicate completion and failure. File outputs link to Artifacts. AI edits show instruction, operations, resulting revision and undo. Publication summarizes validation and locked Agent versions.

## Changelog

### 2026-08-29

- Defined the first-phase ComfyUI-inspired workspace layout, creation flow, agent palette, grouped settings, and responsive inspector behavior while retaining linear execution.
- Extended the editor model to generic Text and Agent nodes with immutable AgentVersion and file Artifact context.

### 2026-08-13

- Established the ordered-step Workflow Editor specification.
