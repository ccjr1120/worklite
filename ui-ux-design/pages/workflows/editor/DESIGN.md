# Workflow Editor

## Route

`/workflows/{new,:workflowId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/workflows/$workflowId.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Model

The workflow editor presents a directed control-flow dataflow graph with structured conditional edges and bounded loop edges. The palette includes Timer, Workflow Input, Dashboard, Agent, Artifact, Artifact Query, Image, and the trusted WeChat Official Account Publish node when its built-in Plugin is available. Timer is a source trigger with no inputs, one JSON output, an enabled control, and a fixed interval of at least five minutes; each Workflow may contain at most one Timer. Dashboard has one required JSON `data` input, one JSON `output` port, and at most one instance per Workflow. Workflow Input exposes the run input and may connect explicitly to Agent `context` as the initial token. Agent owns its immutable embedded configuration and has one optional `context` input plus one output; when `context` has no explicit Workflow Input edge and no unbounded incoming edge, the initial Agent invocation uses the Workflow Run input, while later bounded-loop traversals supply the next context value. Its inspector selects `Text` or `JSON` output format. Artifact has one required JSON `data` input, one output, and permits multiple instances; it configures a non-empty display name and a `Text`, `Markdown`, or `JSON` artifact type. Artifact Query has one required JSON `request` input and one JSON output; its inspector selects a JSON Artifact name, a top-level title field, and one or more top-level description fields. It reads matching workspace history, including detached Artifacts, and emits the request with compact title-and-description candidates without creating Artifacts. Image has one required string `prompt` input and one JSON output. Its inspector fixes `codex/gpt-image-2` and exposes only the supported image count, background, quality, and size choices. The node displays an image summary after execution and never renders or inspects base64 data. The WeChat node accepts required Markdown `article` and generated cover-image inputs plus optional JSON `metadata` and outputs a publication reference. One output may fan out to multiple downstream nodes. Each named input accepts at most one edge, except Agent `context`, which may combine one unbounded initial upstream edge with one bounded feedback edge. An initial Workflow Input edge must remain unconditional. Edges may be unconditional, predicate-based, or fallback routes. A loop-closing edge must define a positive maximum traversal count, and every possible cycle must cross at least one bounded edge. Dynamic joins and parallel execution remain unavailable.

## Layout and Interaction

The context bar contains breadcrumb, saved state, revision history, Run where valid, and Publish. The editor workspace has a central `@xyflow/react` canvas and one right-side contextual panel. React Flow selection is authoritative and synchronizes the selected node or edge with the panel. With no selection, the panel shows the searchable node palette. Selecting a node or edge replaces the palette with its inspector; clicking the canvas background or using the inspector's back action clears all graph selection and restores the palette. Palette and inspector content always use the panel's full available width. The canvas supports node dragging, handle-to-handle connection, edge selection and deletion, pointer-drag panning, free horizontal and vertical trackpad or wheel panning, pinch zoom, zoom controls, and fit-to-view. Ordinary wheel input pans instead of zooming. It intentionally does not render a minimap or a canvas-wide selection outline; selected nodes use a persimmon node border, selected edges use a persimmon stroke, and keyboard focus remains visible on the focused node, edge, or control. React Flow primitives follow the resolved light or dark application theme. On smaller breakpoints the combined contextual panel becomes one drawer or sheet, opens automatically for a canvas selection, and closes when the fixed desktop panel becomes available. An optional AI assistant panel accepts instructions and presents reviewable structured operations. A bottom panel shows test output, logs and artifacts.

The creation flow offers a blank workflow or a starter template, then collects the workflow name and initial input. The node palette adds a node at the center of the visible canvas viewport. Each node shows its type, embedded Agent configuration context when applicable, named handles, error policy, validation and execution state. Agent nodes show the optional `context` input and output so composition remains clear at normal zoom. Selection reveals duplicate and remove commands in the inspector. Edge selection reveals endpoints, routing mode, structured predicate controls, maximum traversals, and a remove command. Predicate controls include a dot-delimited source-output path, a supported comparison operator, and a JSON comparison value when the operator requires one. Fallback routes explain that they run only when no unconditional or predicate edge from the same source invocation matches. Conditional edges show a concise condition label on the canvas; bounded edges use a dashed line and a traversal-limit label. Pointer dragging is not required to review, configure, or remove graph objects.

Dashboard nodes expose only a `header`, `main`, and `footer` layout editor. Each region holds an ordered list of elements added from the generic kinds `text`, `count`, `metric`, and `list`. `text` edits static text, `count` and `metric` edit a visible label (`metric` also binds a field key and a text, number, boolean, or datetime type), and `list` edits a title-key binding plus its own display fields, each with a unique non-empty key, visible label, and supported type (`text`, `number`, `boolean`, `datetime`, or `url`; `url` fields become row links instead of rendered text). The inspector explains that the node becomes the Home board only after Publish, that Home reads its output from a successful Run, and that the board title is the Workflow name. Agent nodes are created without selecting a standalone Agent. Their inspector directly exposes a public model selector, system prompt, Skill multi-selection, MCP server multi-selection, and error policy. Skill and MCP choices come only from real workspace resources. Run targets the latest published version, is unavailable while the draft has unsaved changes, and labels that version boundary explicitly. The output panel contains only persisted output from a selected run; it does not show seeded logs. AI editing controls appear only when a server-backed proposal operation exists and never simulate an applied edit.

Artifact nodes expose name and artifact-type controls and explain that a successful Run creates the Artifact while the node output carries its reference. Artifact Query nodes expose the JSON Artifact name, title field, and description fields as labeled controls. The inspector explains that the query reads all matching workspace history, including detached Artifacts and unfinished Research Notes, without editing them; the output carries the original request and candidate metadata. An empty result is an empty candidate list, not an error. The node and controls reuse neutral surfaces, theme-aware semantic tokens, non-color execution cues, visible keyboard focus, and the existing responsive contextual sheet. Agent nodes are created without selecting a standalone Agent.

The Image inspector presents the fixed model and compact count, background, quality, and size controls. The WeChat Official Account Publish inspector selects the configured official account and `Save draft` or `Publish` mode. The required cover input is reserved for a Workflow Image output; the inspector explains that the generated PNG is uploaded through the real MP cover picker and never offers a placeholder fallback. Metadata may provide a title override, author, and digest; otherwise the node reads the first Markdown heading as the title. The inspector explains that Publish may pause the Run for login or final confirmation. Workflows containing both an enabled Timer and a Publish-mode WeChat node are invalid in the initial increment.

Workflow-level settings are grouped into General, Inputs, Execution, and Versioning sections. General contains the workflow name and publication metadata; Inputs contains the input editor and examples; Execution contains default error policy and runtime defaults; Versioning contains draft, revision and publication context. Keep advanced settings collapsed until requested. Scheduling is configured only through the Timer node, not through Workflow settings.

Selecting a Timer opens contextual inspector controls for `enabled` and the interval in minutes, with a five-minute minimum. The inspector explains that draft Timer changes become active only after Publish. For a published Workflow, the inspector also shows read-only runtime status when available: the bound published version, next-run time, and last-run status. Timer surfaces, default icons, and ordinary hover states remain neutral; selected, focused, or actively executing states may use the brand token. Controls require accessible labels and non-color status cues in both themes.

Connect nodes with quiet directional edges. Persimmon indicates selection and current execution; semantic markers indicate completion and failure. Port labels and accessible names identify context and output semantics without relying on color. While connecting, compatible and incompatible targets have distinct visual states. Invalid or type-incompatible connection attempts leave graph state unchanged and present concise feedback. Run artifact rows link to Artifact details; Artifact node outputs carry references. AI edits show instruction, operations, resulting revision and undo. Publication validates bounded-cycle constraints, port rules, public model ids, image generation settings, required WeChat cover connectivity, and selected Skill and MCP availability.

## Portable JSON

The editor header provides a secondary `Export JSON` action for saved workflows. It downloads the current draft in the portable WorkLite workflow format. Unsaved new workflows must be saved before export. The action is neutral in light and dark modes and does not compete with primary save, run, or publish actions.

The editor header also provides a destructive Delete action for saved workflows. It opens a confirmation dialog that names the Workflow and explains permanent removal of its drafts, published versions, schedules, and run history. Successful deletion closes the dialog, presents a success toast, and returns to the Workflow list; failed deletion keeps the dialog open with visible feedback.

## Changelog

### 2026-09-18

- Added Artifact Query to the existing palette and contextual inspector with a required request port, configurable JSON Artifact name and title/description fields, and compact historical candidate output.
- Generalized the Agent context loop connection to one initial upstream edge plus one bounded feedback edge; explicit Workflow Input edges remain unconditional.
- Reused the established neutral node, named port, accessible form, light/dark, and responsive panel patterns without changing design tokens.

### 2026-09-17

- Added the neutral Image node and constrained image-generation inspector, plus the required WeChat cover connection and generated PNG upload explanation. Image execution presents a credential-safe image summary without exposing base64 data.
- Allowed an explicit Workflow Input-to-Agent context connection to coexist with one bounded feedback edge.
- Kept the connection neutral in both themes, preserved the existing edge presentation, and continued to reject ambiguous unbounded-forward or duplicate initial-input combinations.

### 2026-09-16

- Added edge-inspector controls for unconditional, predicate, and fallback routing.
- Added structured source-output path, operator, JSON comparison value, and maximum-traversal fields without exposing executable expressions.
- Allowed bounded cycle connections, seeded nodes with no unbounded incoming edges and no connected required inputs for their initial invocation, rendered bounded edges with dashed styling, and displayed concise condition and traversal labels on the canvas.
- Kept the existing selection-driven contextual panel, responsive Sheet behavior, neutral surfaces, and sequential execution presentation.

### 2026-09-16

- Added the WeChat Official Account Publish node, account and mode configuration, article and metadata ports, and pending-authentication explanation.

### 2026-09-15

- Added Artifact to the first-party node palette and inspector with required `data`, Artifact-reference output, name, and text/markdown/json type controls.
- Removed implicit Agent file-output controls; Agent remains text or JSON output only.
- Kept node surfaces neutral and used the shared selected, focused, and execution treatments for Artifact nodes.

### 2026-09-15

- Added `url` to list display-field types; metric elements keep text, number, boolean, and datetime.
- Replaced Dashboard title and display-field configuration with the compositional header, main, and footer layout editor supporting text, count, metric, and list elements.
- Removed the Dashboard description field; the node configures only its layout.
- Removed the title-field selector; list elements own their title-key binding and display fields, and board titles come from the Workflow name.
- Kept the editor in place after starting a published-version Run and confirmed success with a toast; Run history remains available from the Workflow list dialog.

### 2026-09-14

- Removed Text and Skill Set from the first-party palette and moved all prompt, Skill, and MCP ownership into the Agent inspector.
- Defined Agent `context` as optional and used Workflow Input as its context when no edge is connected.

### 2026-09-14

- Added a Dashboard title-field selector that binds each output record title to a configured display field.

### 2026-09-14

- Added an Agent inspector output-format selector with Text and JSON modes.
- Defined JSON mode as parsing the final Agent response into Workflow JSON, with invalid JSON failing the node.
- Used the shared selector pattern with accessible labels, keyboard support, semantic styling, and light/dark parity.

### 2026-09-14

- Added the first-party Dashboard node with title, description, display-field configuration, required JSON input, and one-output pass-through behavior.
- Limited Dashboard to one node per Workflow and explained that Publish activates its Home board eligibility.

### 2026-09-14

- Added the first-party Timer source node with enabled and five-minute-minimum interval controls in the contextual inspector.
- Made Publish activate Timer changes and removed the independent schedule form from Workflow Execution settings.
- Defined enabled, interval, bound version, next-run, last-status, unpublished, loading, and failure states without coupling scheduling to Home.

### 2026-09-10

- Refined successful deletion to close its dialog before showing feedback and returning to the Workflow list.
- Added permanent deletion for saved Workflows with named confirmation and return to the Workflow list.

### 2026-09-10

- Replaced standalone Agent and version selection with inline Workflow Agent configuration for model, system prompt, Skills, MCP servers, and error policy.
- Reduced the Workflow Agent graph contract to one upstream context input and one output.

### 2026-09-09

- Added the Export JSON action for downloading the current portable workflow draft.

### 2026-09-01

- Enabled free horizontal and vertical trackpad or wheel panning while retaining pointer-drag panning, pinch zoom, and explicit zoom controls.
- Merged the node palette and inspector into one right-side contextual panel with selection-driven content and one responsive Sheet.
- Removed the canvas-wide focus outline and required palette and inspector content to fill the contextual panel width.
- Unified selection under React Flow, added node-local selection and focus styling, theme-aware edges, visible port labels and connection feedback, textarea wheel isolation, viewport-centered insertion, and responsive panel cleanup.

### 2026-08-31

- Added Workflow Input, Skill Set, and Agent node presentation with a named context port.
- Made reusable prompts and Skill authorization visible as graph connections while retaining sequential execution and one edge per input port.
- Replaced the fixed ordered sequence with an `@xyflow/react` DAG canvas supporting persisted layout, explicit edges, data fan-out, panning, zooming, fit-to-view, and a minimap.
- Added inline Text editing and contextual node and edge configuration while deferring conditions, joins, loops, and parallel execution.
- Restored the `@xyflow/react` implementation and removed the minimap while retaining the same graph contract.

### 2026-08-29

- Removed simulated templates, AI edits and run logs from the editor contract; required real workspace embedded Agent configurations, explicit published-version Run behavior and persisted output only.

### 2026-08-29

- Defined the first-phase ComfyUI-inspired workspace layout, creation flow, agent palette, grouped settings, and responsive inspector behavior while retaining linear execution.
- Extended the editor model to generic Text and Agent nodes with immutable embedded Agent configuration and file Artifact context.

### 2026-08-13

- Established the ordered-step Workflow Editor specification.
