# Workflow Editor

## Model

The initial workflow is a fixed ordered sequence of agent steps. It is not a graph canvas and does not support arbitrary edges, branching, loops, parallel execution or backward jumps.

## Layout and Interaction

The context bar contains breadcrumb, saved state, revision history, Run or Preview where valid, and Publish. Main content contains workflow input and a vertical step sequence. The inspector edits the selected step. An optional AI assistant panel accepts instructions and presents reviewable structured operations. A bottom panel shows test output, logs and artifacts.

Each step shows position, agent and version context, input mapping summary, runtime overrides, error policy, validation and execution state, plus accessible move up, move down and remove actions. Use explicit `Add step` controls between steps and at the end. Reordering must not depend on drag-and-drop.

Connect steps with a quiet timeline. Persimmon indicates selection and current execution; semantic markers indicate completion and failure. AI edits show instruction, operations, resulting revision and undo. Publication summarizes validation and locked Agent versions.

## Changelog

### 2026-08-13

- Established the ordered-step Workflow Editor specification.
