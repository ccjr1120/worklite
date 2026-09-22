# Workflow Editor

## Route

`/workflows/{new,:workflowId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/workflows/$workflowId.tsx`
- `apps/web/src/components/workflow-canvas-nodes.tsx`

## Purpose

Build and configure a Workflow graph, then publish it as an immutable version that can run.

## Primary Task

Change the graph and persist the change. Action budget: two — edit the graph, then `Save`.

The budget is above one because the graph is a composite draft rather than a single field: a node addition, a connection, and an inspector change accumulate into one revision, and the user decides when that revision is coherent enough to persist. Autosaving a half-connected graph would produce invalid intermediate revisions in the undo history. The editor compensates by showing `Saving`, `Saved`, and `Unsaved changes` continuously, so the unsaved state is never ambiguous.

`Publish` is a separate, irreversible goal and keeps its own confirmation step.

## Model

The workflow editor presents a directed control-flow dataflow graph with structured conditional edges and bounded loop edges.

The palette includes Timer, Workflow Input, Agent, Choice Branch, Dashboard, Artifact, Artifact Query, Image, and the trusted WeChat Official Account Publish node when its built-in Plugin is available.

- **Timer** is a source trigger with no inputs, one JSON output, an enabled control, and a fixed interval of at least five minutes; each Workflow may contain at most one Timer.
- **Dashboard** has one required JSON `data` input, one JSON `output` port, and at most one instance per Workflow.
- **Workflow Input** exposes the run input and may connect explicitly to Agent `context` as the initial token.
- **Agent** owns its immutable embedded configuration and has one optional `context` input plus one output. When `context` has no explicit Workflow Input edge and no unbounded incoming edge, the initial Agent invocation uses the Workflow Run input, while later bounded-loop traversals supply the next context value. Its inspector selects `Text` or `JSON` output format.
- **Choice Branch** has one required JSON `value` input and one JSON `output` port. It passes the input through unchanged and evaluates its outgoing unconditional or predicate edges in connection order, traversing only the first match; when no non-fallback edge matches, it traverses the first fallback edge. It can consume JSON from any upstream node.
- **Artifact** has one required JSON `data` input, one output, and permits multiple instances; it configures a non-empty display name and a `Text`, `Markdown`, or `JSON` artifact type.
- **Artifact Query** has one required JSON `request` input and one JSON output; its inspector selects a JSON Artifact name, a top-level title field, and one or more top-level description fields. It reads matching workspace history, including detached Artifacts, and emits the request with compact title-and-description candidates without creating Artifacts.
- **Image** has one required string `prompt` input and one JSON output. Its inspector fixes `codex/gpt-image-2` and exposes only the supported image count, background, quality, and size choices. The node displays an image summary after execution and never renders or inspects base64 data.
- **WeChat Official Account Publish** accepts required Markdown `article` and generated cover-image inputs plus optional JSON `metadata`, and outputs a publication reference.

One output may fan out to multiple downstream nodes. Choice Branch output is the deliberate exception to that fan-out behavior: its outgoing routes are exclusive and only the first matching route is traversed. Each named input accepts at most one edge, except Agent `context`, which may combine one unbounded initial upstream edge with one bounded feedback edge. An initial Workflow Input edge must remain unconditional. Edges may be unconditional, predicate-based, or fallback routes. A loop-closing edge must define a positive maximum traversal count, and every possible cycle must cross at least one bounded edge. Dynamic joins and parallel execution remain unavailable.

## Layout

The context bar contains breadcrumb, saved state, revision history, Workflow settings, Versions, `Export JSON`, the destructive delete action, `Save`, `Run` where valid, and `Publish`.

The editor workspace has a central `@xyflow/react` canvas and one right-side contextual panel. React Flow selection is authoritative and synchronizes the selected node or edge with the panel. With no selection the panel shows the searchable node palette; selecting a node or edge replaces the palette with its inspector; clicking the canvas background or using the inspector's back action clears all graph selection and restores the palette. Palette and inspector content always use the panel's full available width.

The canvas supports node dragging, handle-to-handle connection, edge selection and deletion, pointer-drag panning, free horizontal and vertical trackpad or wheel panning, pinch zoom, zoom controls, and fit-to-view. Ordinary wheel input pans instead of zooming. It intentionally renders no minimap and no canvas-wide selection outline: selected nodes use a persimmon node border, selected edges use a persimmon stroke, and keyboard focus remains visible on the focused node, edge, or control. React Flow primitives follow the resolved light or dark application theme.

On smaller breakpoints the combined contextual panel becomes one drawer or sheet, opens automatically for a canvas selection, and closes when the fixed desktop panel becomes available. A bottom panel shows test output, logs, and artifacts.

Workflow-level settings are grouped into General, Inputs, Execution, and Versioning. General contains the workflow name and publication metadata; Inputs contains the input editor and examples; Execution contains default error policy and runtime defaults; Versioning contains draft, revision, and publication context. Advanced settings stay collapsed until requested. Scheduling is configured only through the Timer node, never through Workflow settings.

## Interaction Contract

**Add a node.** The searchable palette inserts the node at the center of the visible canvas viewport, selects it, and marks the draft unsaved. Insertion never requires pointer dragging.

**Connect nodes.** Handle-to-handle connection validates against the port rules above. While connecting, compatible and incompatible targets have distinct visual states. An invalid or type-incompatible attempt leaves graph state unchanged and reports concisely. A connection that would close a cycle receives a bounded traversal limit rather than being rejected.

**Configure a selection.** Selecting a node or edge opens its inspector. Node inspectors expose node-owned parameters directly. Edge selection reveals endpoints, routing mode, structured predicate controls, maximum traversals, and a remove command. Predicate controls take a dot-delimited source-output path, a supported comparison operator, and a JSON comparison value when the operator requires one. Fallback routes explain that they run only when no unconditional or predicate edge from the same source invocation matches. Conditional edges show a concise condition label on the canvas; bounded edges use a dashed line and a traversal-limit label. Pointer dragging is never required to review, configure, or remove graph objects.

**Save.** Persists the accumulated revision. The save state reports `Saving` and settles on `Saved`. A failure returns the state to `Unsaved changes` and keeps the reason visible in the canvas region rather than only in a toast. An invalid edge comparison value blocks the save and names that specific problem.

**Undo and redo.** Server-backed revision movement, reported through the same save state. Both controls disable while a save is in flight.

**Run.** Targets the latest published version, is unavailable while the draft has unsaved changes, and labels that version boundary explicitly. The control reports busy on itself. After the server returns the new Run id, navigation enters `/runs/:runId` so the live Run detail becomes the immediate execution surface; Run history remains available in the Workflow List dialog.

**Publish.** Opens a confirmation explaining that publishing locks the embedded Agent configuration and that later draft edits do not change this Workflow or its historical runs. Publication validates bounded-cycle constraints, port rules, public model ids, image generation settings, required WeChat cover connectivity, and selected Skill and MCP availability. Validation failures navigate directly to the affected content.

**Export JSON.** Downloads the current draft in the portable WorkLite format. Unsaved new Workflows must be saved first. The action stays neutral in both themes and does not compete with save, run, or publish.

**Delete.** Opens a confirmation naming the Workflow and explaining permanent removal of its drafts, published versions, schedules, and run history. Success closes the dialog, reports the outcome, and returns to the Workflow list; failure keeps the dialog open with visible feedback.

The Timer inspector's read-only runtime status is the one self-healing value here: it follows the workflow schedule query rather than a manual refresh. Everything else on this surface is draft state the user owns directly.

## Node Inspectors

**Dashboard** nodes expose only a `header`, `main`, and `footer` layout editor. Each region holds an ordered list of elements added from the generic kinds `text`, `count`, `metric`, and `list`. `text` edits static text; `count` and `metric` edit a visible label, and `metric` also binds a field key and a text, number, boolean, or datetime type; `list` edits a title-key binding plus its own display fields, each with a unique non-empty key, visible label, and supported type (`text`, `number`, `boolean`, `datetime`, or `url`, where `url` fields become row links instead of rendered text). The inspector explains that the node becomes the Home board only after Publish, that Home reads its output from a successful Run, and that the board title is the Workflow name.

**Agent** nodes are created without selecting a standalone Agent. Their inspector directly exposes a public model selector, system prompt, Skill multi-selection, MCP server multi-selection, output format, and error policy. Skill and MCP choices come only from real workspace resources.

**Choice Branch** nodes expose no provider-specific configuration. Their inspector explains that the JSON value is passed through and that outgoing conditions are evaluated in connection order, with only the first match or first fallback traversed. Use the edge inspector to configure JSON paths such as `$.articleType` and their comparison values.

**Artifact** nodes expose name and artifact-type controls and explain that a successful Run creates the Artifact while the node output carries its reference.

**Artifact Query** nodes expose the JSON Artifact name, title field, and description fields as labeled controls. The inspector explains that the query reads all matching workspace history, including detached Artifacts and unfinished Research Notes, without editing them, and that the output carries the original request and candidate metadata. An empty result is an empty candidate list, not an error.

**Image** inspectors present the fixed model and compact count, background, quality, and size controls.

**WeChat Official Account Publish** inspectors select the configured official account and `Save draft` or `Publish` mode. The required cover input is reserved for a Workflow Image output; the inspector explains that the generated PNG is uploaded through the real MP cover picker and never offers a placeholder fallback. Metadata may provide a title override, author, and digest; otherwise the node reads the first Markdown heading as the title. The inspector explains that Publish may pause the Run for login or final confirmation. Workflows containing both an enabled Timer and a Publish-mode WeChat node are invalid in the initial increment.

**Timer** inspectors expose `enabled` and the interval in minutes with a five-minute minimum, and explain that draft Timer changes become active only after Publish. For a published Workflow the inspector also shows read-only runtime status when available: the bound published version, next-run time, and last-run status.

Node surfaces, default icons, and ordinary hover states remain neutral; selected, focused, or actively executing states may use the brand token. Every control requires an accessible label and a non-color status cue in both themes.

## States

| State | Behavior |
| --- | --- |
| Loading | An existing Workflow's draft loads into a content-shaped canvas and panel rather than an empty graph. A new Workflow starts empty by definition, not by absence of data. |
| Empty | An empty canvas states that nodes are added from the palette. |
| No results | A palette search with no match names the query. |
| Error | Save, publish, run, export, and delete failures stay visible next to their action or affected content. The Timer schedule region reports its own unavailability without affecting the rest of the inspector. |
| Busy | Save reports through the save state; run, publish, export, and delete report on their own controls. Undo and redo disable only while a save is in flight. |
| Offline | Inherits `shared-states.md`. Draft edits are local until saved, and the offline bar states that. |
| Long content | The canvas pans and zooms rather than growing the page. The contextual panel scrolls internally. The output panel shows only persisted output from a selected run and never seeded logs. |

The output panel contains only persisted output from a selected run. AI editing controls appear only when a server-backed proposal operation exists and never simulate an applied edit.

## Copy Inventory

| Key | Category |
| --- | --- |
| `workflows:editor.new` / `editor.fallback` / `editor.untitled` | State |
| `workflows:editor.name` / `editor.input` / `editor.nodeName` | State |
| `workflows:editor.nodePalette` / `editor.paletteHint` / `editor.searchNodes` | Action |
| `workflows:editor.canvas` / `editor.emptyCanvas` | State |
| `workflows:editor.zoomIn` / `editor.zoomOut` / `editor.fitView` | Action |
| `workflows:editor.nodeCount` / `editor.edgeCount` | State |
| `workflows:editor.contextPort` / `editor.inputPort` / `editor.outputPort` / `editor.dataPort` | State |
| `workflows:editor.connections` / `editor.incomingConnections` / `editor.outgoingConnections` / `editor.connection` | State |
| `workflows:editor.selectCanvasItem` | Recovery |
| `workflows:editor.invalidConnection` | Recovery |
| `workflows:editor.timer*` / `editor.schedule*` | State, plus `editor.timerActivatesOnPublish` as Constraint |
| `workflows:editor.timerLimit` / `editor.dashboardLimit` | Constraint |
| `workflows:editor.agentNode*` / `editor.model` / `editor.selectModel` / `editor.systemPrompt` / `editor.skills` / `editor.mcpServers` | State |
| `workflows:editor.branchNode*` / `editor.branchValuePort` / `editor.branchSelectionHint` | State, Constraint |
| `workflows:editor.outputFormat` / `editor.outputFormats.*` | State |
| `workflows:editor.outputFormatDescription` | Constraint |
| `workflows:editor.artifactNode*` / `editor.artifactName` / `editor.artifactType` / `editor.artifactTypes.*` | State |
| `workflows:editor.artifactCreationDescription` | Constraint |
| `workflows:editor.artifactQueryNode*` / `editor.query*` | State, plus `editor.queryDescription` as Constraint |
| `workflows:editor.imageNode*` / `editor.image*` | State |
| `workflows:editor.imageConnectionHint` | Constraint |
| `workflows:editor.wechatNode*` / `editor.wechat*` | State |
| `workflows:editor.wechatCoverHint` / `editor.wechatDraftHint` / `editor.wechatPublishPendingHint` | Constraint |
| `workflows:editor.dashboardNode*` / `editor.dashboardRegion.*` / `editor.elementKinds.*` / `editor.element*` / `editor.field*` | State |
| `workflows:editor.dashboardActivation` | Constraint |
| `workflows:editor.edgeMode` / `editor.edgeModes.*` / `editor.edgeOperators.*` / `editor.edgeOutputPath` / `editor.edgeOperator` / `editor.edgeComparisonValue` / `editor.edgeMaxTraversals` / `editor.edgeTraversalLabel` | State |
| `workflows:editor.edgeFallbackHint` / `editor.edgeMaxTraversalsHint` | Constraint |
| `workflows:editor.edgeComparisonInvalid` | Recovery |
| `workflows:editor.run` / `editor.runVersion` / `editor.running` | Action, State |
| `workflows:editor.saveBeforeRun` / `editor.saveBeforePublish` / `editor.publishBeforeRun` / `editor.saveBeforeExport` | Recovery |
| `workflows:editor.runFailed` / `editor.saveFailed` / `editor.publishFailed` / `editor.exportFailed` | Recovery |
| `workflows:editor.publishTitle` | State |
| `workflows:editor.publishDescription` | Constraint |
| `workflows:editor.published` / `editor.exported` | State |
| `workflows:editor.exportJson` / `editor.versions` / `editor.workflowSettings` | Action |
| `workflows:editor.general` / `editor.inputs` / `editor.execution` / `editor.versioning` / `editor.defaultErrorPolicy` | State |
| `workflows:editor.versioningHint` | Constraint |
| `workflows:editor.duplicate` / `editor.remove` | Action |
| `workflows:delete.*` | Action, Constraint, State, Recovery |
| `common:actions.save` / `actions.publish` / `actions.cancel` | Action |
| `common:saveState.*` | State |

`workflows:editor.workflowSettingsDescription` is removed: it restates the settings heading and adds only an assurance about not leaving the editor.

The following keys are removed as orphans from features this editor no longer has. They belong to the ordered-step model, the simulated AI assistant, and the Text node, all of which earlier changelog entries removed, and none is referenced by any source file:

`editor.sequence`, `editor.stepCount`, `editor.step`, `editor.agentPalette`, `editor.searchAgents`, `editor.agentFallback`, `editor.insertFirst`, `editor.insertAt`, `editor.addStep`, `editor.addStepStart`, `editor.addStepAfter`, `editor.moveUp`, `editor.moveDown`, `editor.selectStep`, `editor.inputMapping`, `editor.mappingLiteralOutput`, `editor.mappingInputOutput`, `editor.mappingPreviousOutput`, `editor.textNode`, `editor.textType`, `editor.literalTextInput`, `editor.aiEdit`, `editor.assistant`, `editor.assistantHint`, `editor.assistantPlaceholder`, `editor.propose`, `editor.pendingOperation`, `editor.pendingDescription`, `editor.apply`, `editor.applied`, `editor.runOutput`, `editor.overridesHint`, `editor.previewStarted`, `editor.dailyTemplatePrompt`.

## Accessibility

The graph is fully operable without pointer dragging: the palette adds nodes, and the inspector reviews, configures, and removes both nodes and edges. Selection stays synchronized between the canvas and the panel so keyboard focus and inspector content never disagree.

Port labels and accessible names identify context and output semantics without relying on color. Persimmon marks selection and current execution only; completion and failure use semantic markers alongside text. Every icon-only control in the context bar and canvas carries an accessible name, and the zoom, fit-view, and deletion controls keep `40px` to `44px` touch targets at mobile widths. Save failures use `role="alert"`.

## Coverage Status

Verified 2026-09-22. Differences found against `apps/web/src/routes/workflows/$workflowId.tsx`:

- ~~The editor had no reusable JSON Choice Branch node.~~ Resolved: the palette, canvas, inspector, and graph serializer now expose `worklite/branch@1`; its outgoing conditions select one route in definition order.

- ~~`Run` created a Run but left the editor as the active surface.~~ Resolved: successful creation now navigates to the returned `/runs/:runId` detail route.

- No loading state for an existing Workflow. `useWorkflowQuery` destructures only `data`, so a pending load renders an empty canvas that is indistinguishable from an empty graph; the name field shows `editor.untitled` until the draft arrives.
- No load-failure state. A failed Workflow query leaves the editor on an empty canvas with no explanation, and unsaved work could be attempted against a draft that never loaded.
- `Publish` has no validation feedback path in the UI beyond a toast: `publishWorkflow` reports failure through `toast.error` only, so a validation failure does not navigate to the affected content as this specification requires.
- Run, publish, export, and import failures are toast-only. `shared-states.md` requires durable errors to remain in the page; only `save` writes to the persistent `saveError` region.
- `editor.saveBeforeRun` is reused as the publish precondition message when `isNew`, so publishing a brand-new Workflow tells the user to save before *running* it.
- 34 locale keys under `workflows:editor.*` are orphaned, enumerated in the Copy Inventory above.
- `editor.emptyCanvas` is defined and referenced once but the canvas renders no empty-state text region, so an empty graph shows a bare grid.
- Delete sets `setDeleteBusy(true)` and only resets it inside the `catch`, relying on navigation to unmount the component on success; the busy flag is never cleared on the success path.

## Changelog

### 2026-09-22 - JSON Choice Branch

- Added the generic Choice Branch node with a required JSON input, pass-through output, exclusive first-match routing, and first-fallback behavior. It is independent of any Provider protocol and uses the existing structured edge inspector.

### 2026-09-22 - Run detail navigation

- Changed the editor's Run completion path to open the returned Run detail route so active execution is immediately observable.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the declared action budget with its composite-draft reason, the per-state table, the copy inventory, and verified coverage findings.
- Reorganized the node contracts, inspector rules, and layout guidance under the new headings without changing any graph rule.
- Recorded 34 orphaned `workflows:editor.*` locale keys left behind by the ordered-step, AI-assistant, and Text-node removals, and removed `editor.workflowSettingsDescription` as a restated heading.
- Required durable in-page errors for run, publish, export, and import instead of toast-only feedback.

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
