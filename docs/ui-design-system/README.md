# WorkLite UI Design System

This document is the source of truth for WorkLite user-interface principles and visual language. `ui-ux-design/README.md` defines page structure, shared UI architecture, implementation sequencing, and page-level acceptance criteria. Every UI proposal and implementation must follow both documents through the UI Change Workflow in `AGENTS_WORKFLOW.md`.

## Product Character

WorkLite is a personal workspace for creating and running AI agents and workflows. Its interface should feel lively, fluid, warm, and responsive: every action answers immediately, every state change is visible as motion, and live work is unmistakable at a glance.

The visual identity grows from the orange WorkLite robot mark. A warm persimmon-orange accent, soft layered surfaces, generous rounding, and a shared spring-based motion language replace the earlier flat, border-only grammar.

The interface must:

- Make live execution obvious: running, waiting, and finished work never look alike.
- Respond to every pointer and keyboard action with immediate, physical feedback.
- Move rather than jump: overlays, disclosures, selections, lists, and status changes transition.
- Support sustained use at moderate information density with comfortable spacing.
- Treat light and dark modes as equally important, deliberately designed experiences.

The WorkLite brand mark is the orange robot outline in `apps/web/public/brand/worklite-logo.png`. Use the transparent asset through the shared `WorkLiteMark` component for product-owned branding, onboarding, and browser icons. Do not recreate the mark with a substitute icon or apply a background that reduces its legibility.

## Design Principles

1. **Warm and alive.** Warm neutral surfaces carry content; the orange accent, soft elevation, and motion give the product energy without competing with content.
2. **Layered hierarchy.** Surface tone, soft shadows, rounding, and spacing establish structure; borders are hairlines that support rather than define it.
3. **Visible execution.** Live work is grouped, pinned, and animated; finished work settles into a quiet state. Users never have to read a label to tell running from done.
4. **Fluid feedback.** Controls press, overlays grow from their trigger, disclosures expand, and lists flow. Motion always explains a change and never delays one.
5. **Progressive disclosure.** Common actions remain immediate while advanced configuration stays available without overwhelming the primary flow.
6. **Consistent semantics.** The same color, component, and motion meaning applies throughout the product.
7. **Accessible interaction.** Keyboard access, visible focus, sufficient contrast, non-color cues, and reduced-motion equivalents are baseline requirements.
8. **One action per goal.** A goal has a single activation point. The product does not ask for a step it can take itself, and it recovers from staleness it can observe rather than offering a refresh control. `ui-ux-design/shared/interaction-contract.md` governs the details.
9. **Text earns its place.** Every string is an action, a state, a constraint, or a recovery. Text that restates a heading, repeats what a component already shows, or explains automation the user cannot act on is removed. `ui-ux-design/shared/copy-standards.md` governs the details.

## Color System

All implementation colors must be exposed through semantic design tokens. Raw color values must not be repeated in page or feature code.

### Core Neutrals and Brand

| Token | Light mode | Dark mode | Purpose |
| --- | --- | --- | --- |
| `background` | `#F7F6F3` | `#121110` | Application background, warm off-white or warm near-black |
| `surface` | `#FFFFFF` | `#1B1A18` | Primary content surface |
| `surface-raised` | `#FFFFFF` | `#24221F` | Menus, dialogs, popovers, and elevated panels |
| `surface-subtle` | `#F2F0EC` | `#262421` | Secondary surfaces, hover fill, inset wells |
| `text-primary` | `#211F1C` | `#F0EDE8` | Primary text |
| `text-secondary` | `#6E6A64` | `#A09C96` | Supporting text |
| `border` | `#E7E4DF` | `rgba(255, 255, 255, 0.08)` | Hairline boundaries |
| `input` | `#DEDAD4` | `rgba(255, 255, 255, 0.12)` | Form control boundary at rest |
| `brand` | `#CF4A0C` | `#FF8A3D` | Primary action, selection, focus, and live execution |
| `brand-hover` | `#B8420B` | `#FF9C59` | Brand control hover |
| `brand-active` | `#9F390A` | `#F07A2C` | Brand control active state |
| `brand-subtle` | `#FFF1E8` | `rgba(255, 138, 61, 0.14)` | Selected rows, active navigation, and live-work tint |
| `brand-text` | `#B8420B` | `#FF9C59` | Brand-colored text on neutral or `brand-subtle` surfaces |
| `brand-foreground` | `#FFFFFF` | `#1A0F08` | Text and icons on solid brand fills |

Brand persimmon orange is the signature accent and echoes the WorkLite robot mark. It represents primary action, current selection, keyboard focus, and live execution. A restrained brand gradient (`brand` to a lighter orange) is permitted on the primary button, the brand mark area, and the live-execution glow; it is never used for large backgrounds or ordinary content.

### Semantic Status Colors

Brand color must not replace status meaning. Live execution borrows the brand accent because it is the product's most important state; every other state uses its own hue.

| Status | Light | Dark | Cue |
| --- | --- | --- | --- |
| Running | `brand` | `brand` | Animated live dot with a breathing halo, plus label |
| Waiting for input, paused | `#A15C07` on `#FDF4DC` | `#FBBF24` on amber tint | Pulsing hourglass or pause icon, plus label |
| Completed, succeeded | `#15803D` on `#E9F6EE` | `#4ADE80` on green tint | Check icon that pops in once, plus label |
| Failed, timed out | `#C62828` on `#FDECEC` | `#F87171` on red tint | Cross icon, plus label |
| Information | `#2563EB` on `#EAF1FD` | `#60A5FA` on blue tint | Info icon |
| Queued, cancelled, inactive | `text-secondary` on `surface-subtle` | same tokens | Dashed circle or slash icon |

Amber warning is visually distinct from brand orange through a yellower hue, an amber tint surface, and its own icon. Every status uses at least one non-color cue, such as an icon, label, shape, or motion pattern, and every status color meets WCAG AA against its tint surface.

## Themes

WorkLite supports `System`, `Light`, and `Dark` appearance settings. The default is `System`, and an explicit user selection must persist.

- Resolve the theme before initial paint to prevent a light-theme flash.
- Set the browser `color-scheme` to match the active theme.
- Theme shared editors, charts, scrollbars, diagrams, illustrations, and floating surfaces with the application.
- Preserve the same hierarchy and semantic meanings across themes.
- Do not create dark mode through automatic color inversion.
- Use subtle transition timing and respect `prefers-reduced-motion`.

Light mode should feel warm and open, using a paper-like off-white canvas with white floating surfaces. Dark mode should feel deep and cozy, using warm charcoal rather than pure black or blue-gray; elevation in dark mode comes from lighter surface tone plus a faint top highlight rather than heavier shadows.

## Typography

Use `Inter`, `Geist`, or a compatible modern system sans-serif stack. Use a monospace stack for code, identifiers, variables, model parameters, and logs. Enable tabular numbers for changing metrics and aligned numeric data.

| Role | Size | Weight |
| --- | --- | --- |
| Page title | `24px` | `600` |
| Section title | `16px` | `600` |
| Component title | `14px` | `600` |
| Body | `14px` | `400` |
| Secondary text | `13px` | `400` |
| Label | `12px` | `500` |
| Code and data | `12px` to `13px` | `400` or `500` |

Use concise, direct source copy and preserve the same meaning and tone in every supported locale. Avoid promotional language inside the application. Labels must describe actions or content without relying on placeholder text. Every string must qualify as an action, a state, a constraint, or a recovery under `ui-ux-design/shared/copy-standards.md`; section and page descriptions are optional and exist only to state a constraint or bound a scope. Use the fixed Chinese resource set for all product copy and locale-aware formatting.

## Spacing and Layout

Use a `4px` base spacing grid.

- Page padding: `24px` on desktop, `16px` below `md`.
- Major section gap: `28px`.
- Standard panel padding: `20px`.
- Form-field gap: `18px`.
- Compact element gap: `8px`.
- Icon-to-label gap: `6px` to `8px`.
- Standard control height: `38px`. Every input, select trigger, and default button in one toolbar shares this height.
- Compact control height: `32px`, used together as a set, never mixed with standard controls in one row.
- Top context bar height: `56px`.
- Primary sidebar width: `240px`.

Single-line controls never wrap. Inputs, select triggers, buttons, badges, tabs, chips, and menu items keep one line and truncate overflowing text with an ellipsis; the full value remains available through a tooltip, the open menu, or a details view.

The default application shell uses a stable sidebar, a compact context bar, a primary content region, and an optional contextual inspector. Logs or execution output may use a resizable lower panel when persistent visibility is valuable.

Responsive layouts must preserve task priority. Secondary inspectors may collapse into drawers, while primary actions and current state remain accessible.

## Shape, Borders, and Elevation

- Small elements (checkbox, menu item, tag): `8px` radius.
- Buttons, inputs, and select triggers: `10px` radius.
- Cards and panels: `14px` radius.
- Popovers and menus: `12px` radius.
- Dialogs and sheets: `18px` radius.
- Status badges, chips, and the composer submit control use a pill shape.
- Hairline borders are `1px`.

Elevation is expressed through four shared shadow tokens rather than page-local shadows:

| Token | Use |
| --- | --- |
| `shadow-xs` | Resting cards, segmented controls, and the selected tab pill |
| `shadow-sm` | Hovered interactive cards and the floating composer |
| `shadow-md` | Popovers, menus, select content, and tooltips |
| `shadow-lg` | Dialogs, sheets, and the command menu |

Shadows are soft, warm-tinted, and multi-layered in light mode; in dark mode they deepen while a `1px` inner top highlight separates layers. The context bar and floating overlays may use a translucent surface with background blur so content scrolls visibly beneath them. Use cards for distinct objects and groups; flat sections inside a card are separated by spacing or hairlines rather than nested cards.

## Components

### Navigation

Keep navigation grouped by task. Keep the first-level menu concise and direct; related views owned by a destination use stable in-page tabs instead of child sidebar menus. The selected item uses a `brand-subtle` pill, `brand-text` icon, and stronger text; the pill glides between items rather than jumping. A destination with live work, such as Chat with a running conversation, shows a small animated live dot beside its label or icon. Do not fill the entire sidebar with brand color.

### Tabs and Segmented Controls

Page-level and panel-level tabs use one shared underline style: neutral labels, with an orange indicator that slides to the selected tab. Compact mode switches inside toolbars use a segmented control whose selected pill slides. Feature code must not define its own tab styling.

### Buttons

- **Primary:** solid brand orange with a subtle top-to-bottom gradient and `shadow-xs` for the most important action in the current context.
- **Secondary:** white or raised surface with a hairline border and `shadow-xs` for supporting actions.
- **Ghost:** toolbars, inline actions, and low-emphasis controls.
- **Destructive:** red and reserved for genuinely destructive actions.

Every button presses: on active it scales to `0.97` and returns with the spring curve. Prefer one primary action per visible region. Loading actions must respond immediately and preserve enough label context to explain what is happening. Progress belongs on the activated control, not on the region around it.

Do not pair a preparation control with a commit control for one goal. When a step is always required before committing, the commit performs it. A manual refresh control is permitted only when the product cannot observe that the value is stale.

### Forms

Keep labels visible above fields. Placeholder text provides examples only. Place help and validation messages next to the relevant field. Clearly communicate `Saving`, `Saved`, and `Unsaved changes` states. Group advanced configuration and disclose it progressively. Use dedicated editors for prompts, code, and structured data.

Form controls use one crisp boundary at rest. Hover may strengthen that boundary with neutral contrast, while keyboard focus replaces it with the brand-colored boundary and one soft, translucent halo without a gap. Do not stack an outline, border, and offset ring into multiple hard focus borders. Invalid controls use the same treatment with the error color. Disabled controls keep their boundary and surface legible without hover or active feedback.

Apply the same focus language to buttons, selection controls, tabs, menu items, and custom interactive rows. Borderless or inset interactions use one contained focus indicator that follows the component shape. Pointer, hover, active, focus, disabled, and invalid states must remain consistent across local and shared controls.

Switches slide their thumb with the spring curve; checkboxes and radios draw their mark with a short scale-in. Textareas grow with content up to a bounded height instead of scrolling a fixed box.

### Select, Menus, and Popovers

An overlay attached to a field matches that field. Select content, comboboxes, and field-anchored popovers use exactly the trigger width; long options truncate with an ellipsis and keep the full text available on hover. Free-standing menus opened from icon or toolbar buttons keep a shared minimum width instead. Every overlay grows from its trigger: it scales from `0.96` and fades in from the side it opens toward, then reverses on close. The selected option shows a check mark; the highlighted option uses `surface-subtle`, not brand fill.

### Tables and Lists

Prefer lists or tables for agents, workflows, and runs when scanability matters. Use row heights around `48px` to `52px`, subdued headers, predictable sorting, visible filter chips, and on-hover secondary actions that fade in. Keep status near the object name. Truncated identifiers must be copyable. Distinguish an empty collection from a filtered result with no matches. Rows enter with a short staggered rise on first render, and newly added or removed rows animate in place instead of reflowing abruptly.

### Overlays and Feedback

Dialogs are for focused decisions, not routine navigation. They rise and scale in over a blurred dimming layer. Sheets slide from their edge. Toasts communicate transient outcomes, such as a saved change, a copied value, or a started Run, and appear in the lower right with a short slide; important results and errors must remain visible in the page. Error feedback should explain the problem and provide a recovery action when one exists. Reversible local mutations update optimistically and roll back with an inline explanation if the server rejects them.

### Loading

Skeletons use a soft shimmer sweep rather than an opacity pulse. Content replaces a skeleton with a short fade so the layout does not flash.

### Icons

Use Lucide icons consistently, normally at `16px` and at `18px` in primary navigation. Icon-only controls require an accessible name, tooltip, and an adequate interaction target. Emoji are not product icons.

## Product-Specific Patterns

### Chat Workflow Mentions

The Chat workspace mention menu supports published Workflows only. Keep the selected Workflow chip compact and removable so users understand that the mention creates a Workflow Run. Workflow progress uses the existing queued, running, completed, failed, and cancelled status semantics, with text and icon cues in addition to color. Successful Workflow Artifacts appear as restrained transcript cards with a direct details action. Draft Workflows are not listed as runnable mentions.

### Agents

Present agents as configurable work units, not cartoon characters. Identity comes from a restrained geometric symbol or letter mark, name, responsibility, model, available skills or tools, ownership, version, and recent run state.

### AI Response Content

Use one shared streaming Markdown renderer for model-generated text across Chat and future Agent response surfaces. It must handle incomplete Markdown during streaming, GitHub Flavored Markdown, long words, tables, links, lists, quotations, and fenced code without executing embedded HTML or scripts. Product styling wraps the renderer and uses semantic tokens in both themes; transport parsing and conversation state do not belong inside the renderer.

In conversational layouts, user messages align to the right in rounded `brand-subtle` bubbles and remain plain text. Each new message enters with a short fade and rise; streamed text shows a soft caret while tokens arrive. The composer is a floating rounded card with `shadow-sm` that grows with its content and lifts its focus halo when active. Agent responses align to the left with a wider, unframed reading column so structured output remains scannable. Alignment, accessible labels, and optional identity marks distinguish speakers without relying on color. Streaming updates follow the end only when the reader was already at the end, and a return-to-end control appears while they are not.

One Agent turn is one block with one identity mark, however many message segments and Skill calls it contains. Its segments and Skill-call rows share that block's content column, so a turn that answers, runs a script, and answers again reads as one reply instead of as several speakers. Working, cancelled, and failure cues render as inline notes without identity marks, because a status is not a speaker; they remain independent status regions for assistive technology.

Create a Chat response placeholder in the transcript as soon as a turn starts. Show restrained inline progress there instead of replacing or disabling the composer. While a turn is running, keep the draft input editable and replace the send control with a familiar square Stop icon; stopping is a neutral execution control rather than a destructive action. Preserve the draft after completion or cancellation, and use text plus icon cues for working and cancelled states.

A message submitted during a running turn joins a visible removable queue and sends when that turn completes. A composer that accepts a keystroke and silently discards it reports work the product did not do, so queuing is the honest behavior for input the reader has already committed. Queue rows are restrained neutral transcript entries with a count and a per-row remove control, not a second execution surface. The queue pauses in place — keeping every entry and its order — when the turn fails, when the reader stops it, and while a clarification question is pending, and it says that it is paused.

Present inline Skill calls as compact disclosure rows by default. The collapsed row keeps the Skill identity, script name, execution status, and exit code visible without allowing arguments, host details, or raw output to dominate the transcript. A keyboard-accessible disclosure control reveals the complete metadata, warning, and a height-bounded internally scrollable output region. Failed calls remain collapsed unless the user opens them.

Treat `@` selection in the Chat composer as structured dispatch, not decorated message text. Opening `@` presents a searchable keyboard-accessible published Workflow menu with pointer selection, arrow navigation, `Enter`, and `Escape`. A selection becomes one removable mention token before the task text inside the same bordered input surface; it must not appear as a separate adjacent field or region. Only one Workflow may be selected for a task, and its identity remains visible until dispatch or removal. The token and task text may wrap together within that shared surface on narrow screens. Chat does not expose Agent mentions or child sessions.

### Workflow Editor

- Represent workflows in a fixed-scale left-to-right diagram built from HTML stage cards and SVG connections, with explicit input and output ports and deterministic coordinates.
- Keep graph nodes compact: show the node name, kind, and named ports in each card, and place model and detailed configuration in the contextual inspector. Derive `x` from dependency rank and `y` from symmetric lanes; order peers by mean incoming-source topological order, using definition order as the stable tie-break. Recalculate when graph topology changes and browse long flows with native two-axis scrolling, trackpad movement, and Shift+wheel. Do not transform or pan the diagram canvas.
- Use a diagram above a bottom inspector dock that appears only for a selected node or edge. The diagram uses the full height when nothing is selected. Open a floating searchable node picker from the diagram toolbar for independent additions, and from an output connection released on blank canvas for compatible target nodes.
- Keep nodes visually consistent and compact. Expose the name, node kind, and named ports on the canvas; expose editable content and other node-owned parameters in the contextual inspector.
- Add independent nodes through the floating searchable picker. Releasing an output connection on blank canvas opens that picker with compatible target nodes; selecting one creates the node and connection together. Recalculate coordinates from graph topology. Node positions are automatic rather than freely draggable.
- Keep nodes at a readable fixed scale; the scroll container exposes the complete flow without zoom or fit controls.
- Keep edge direction and handle compatibility visible through shape, persistent port labels, and valid or invalid interaction state rather than color alone.
- Preserve a keyboard-accessible inspector path for reviewing configuration and removing selected nodes or edges. The diagram toolbar exposes independent node addition without an idle side palette.
- Keep the selected-item inspector in a bounded, independently scrollable dock below the diagram at every breakpoint. Keep the node picker anchored to the diagram.
- Use brand borders or indicators for the selected and currently executing node or edge; a currently executing node also shows the live breathing halo. Selection belongs to the graph and must remain synchronized with contextual panel content and keyboard focus.
- Represent successful and failed states through compact green or red markers rather than filling the whole node.
- Render edges with restrained neutral strokes and reserve stronger treatment for selection and execution.
- Shorten conditional edge labels to the decision value on the canvas; the inspector retains the full predicate. Selecting a graph item emphasizes its directly connected nodes and edges and softens unrelated paths. A subtle directional animation may run on those selected edges only, with a static equivalent for reduced-motion preferences.
- Automatically recalculate layout after graph topology changes so no manual alignment action is needed.
- Present AI-assisted edits in a side panel and make proposed structured operations understandable and reviewable.
- Group workflow-level settings into General, Inputs, Execution, and Versioning sections, with advanced fields disclosed progressively.

Brand emphasis communicates graph selection and active execution while neutral surfaces and edges keep dense workflows readable. Directional selection animation indicates the path being inspected, not Run progress.

### WeChat Article Output

The real WeChat Official Account body follows [the shared output specification](../../ui-ux-design/shared/wechat-article-output.md), because it is reader-facing content rather than a WorkLite application surface. Mint Cyan identifies headings; paragraphs, emphasis, lists, quotations, and code remain neutral. Tables use a charcoal header with a pale mint top rule and neutral rows. Inline styles keep the output usable inside the MP editor.

### Runs and Logs

Workflow List exposes Run records through a per-Workflow dialog. Use the following canonical run labels: `Queued`, `Running`, `Waiting for input`, `Completed`, `Failed`, and `Cancelled`.

Expanded Run records and Run detail use the immutable Workflow version as a read-only graph. Node cards show the latest invocation status and invocation count; edges show whether a route was traversed or skipped. An ordered execution trace beneath the graph preserves every node invocation and edge decision, including repeated bounded-loop traversals. Selecting a node opens its node-run records in the bottom detail dock, where the existing Input, Activity, Output, failure, and retry content remains available. The graph is an overview of topology and status; the trace is the source for execution order.

A Run waiting on a human-gated browser action presents a compact amber pending-action panel before its node logs. The panel names the required action and shows the QR image. An expired code is replaced automatically, so the panel shows neither an expiry time nor an instruction to refresh: during replacement the current image dims and a status line reports that a new code is arriving. `Cancel run` remains, because abandoning the Run is a separate intent rather than a recovery from staleness. Authentication state is communicated with text and icon cues; the QR is not the only explanation. Completion updates through the existing Run event stream and does not require a separate “I scanned it” control.

Show the current step and continuing progress for long operations. Expanded Workflow Run records present the immutable Workflow as a read-only graph with latest node status and visit count, plus an ordered trace of node invocations and edge decisions. Selecting a node opens its input, activity, output, failure, and retry context in a detail dock. Failed Runs surface the credential-safe failure reason before the graph and repeat it in the failed node's details. Append logs without forcing disruptive scrolling. Use monospace text for identifiers and raw output, and allow users to distinguish timestamps, severity, source, and content. Successful completion should be clear but restrained; failure must include context and a next step where possible. Artifact disclosure is absent when the immutable Workflow version has no Artifact node; an empty Artifact state is reserved for eligible versions that produced none.

Failure is the one node log state that carries a recovery action. When the server reports a failed node entry as retryable, that entry offers a single neutral secondary `Retry node` control beside its failure reason. Retry is an ordinary execution control, not a destructive or primary action, so it uses neutral styling with an icon and text label rather than brand fill or red. Only the retryable entry exposes it; other failed, cancelled, and successful entries show none, and the control never appears at the Run level where it could be mistaken for rerunning the whole Workflow. Activating it shows a local busy state on that control alone, leaves the surrounding log list in place, and keeps any failure text visible until the Run event stream replaces it with continued execution. A retry that the server rejects preserves the original failure reason and explains the rejection in the same entry.

## Motion

Motion is a first-class part of the interface. It is defined once as shared tokens and utilities; feature code composes them rather than writing its own keyframes or durations.

| Token | Value | Use |
| --- | --- | --- |
| `ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default for entrances, color, and layout changes |
| `ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Press release, switch thumb, check pop, indicator glide |
| `ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Exits and reversible disclosures |
| `duration-fast` | `140ms` | Hover, press, color and status transitions |
| `duration-base` | `200ms` | Menus, popovers, tooltips, tab indicator |
| `duration-slow` | `280ms` | Dialogs, sheets, disclosures, route content |

- **Press:** interactive controls scale to `0.97` on active and spring back.
- **Overlays:** grow from their trigger origin with fade and `0.96` scale; dialogs also rise `8px`; sheets slide from their edge.
- **Disclosure:** collapsible content animates its height and opacity rather than appearing.
- **Selection:** tab indicators, segmented pills, and the navigation pill glide between positions.
- **Lists:** first render staggers rows by `30ms` up to eight rows; later additions fade and rise in place.
- **Routes:** page content fades and rises `4px` on navigation; the shell stays still.
- **Status:** status color changes cross-fade; a completed check pops in once; live dots breathe continuously while work runs.
- **Streaming:** streamed assistant text shows a soft caret while tokens arrive.
- Never animate for decoration alone, never delay an action behind an animation, and never animate layout properties that cause visible jank during streaming.
- Respect `prefers-reduced-motion`: transitions shorten to near zero, continuous animations stop, and every static state cue remains.

## Accessibility

- Meet WCAG AA contrast for standard text and essential controls.
- Keep a visible keyboard focus ring in both themes.
- Do not communicate state using color alone.
- Provide interaction targets of at least approximately `32px` for compact desktop controls.
- Associate validation messages with their fields.
- Make icon controls and complex editor controls accessible by name and keyboard.
- Preserve a keyboard-accessible alternative for canvas operations.

## Anti-Patterns

Do not introduce:

- Large areas of brand orange, full-page gradients, or rainbow AI gradients.
- Heavy glassmorphism on content surfaces; blur is limited to the context bar, overlays, and their dimming layer.
- Glow outside live execution, or shadows that are not one of the four shared elevation tokens.
- Oversized marketing typography inside the application workspace.
- Excessive card nesting.
- Page-local keyframes, durations, or easing curves that bypass the shared motion tokens.
- Status rendering that bypasses the shared status component.
- Overlays attached to a field whose width differs from that field.
- Chat interfaces as the default representation of every AI capability.
- Decorative robot imagery as the identity of agents.
- Theme-specific functionality or an unpolished secondary theme.
- Page-local colors, spacing, or radii that duplicate shared tokens.

## UI Decision Checklist

Before confirming a UI proposal, verify that it:

- Supports the product character and user task.
- Uses existing semantic tokens and patterns where possible.
- Defines both light and dark behavior.
- Preserves clear information hierarchy at the intended density.
- Uses brand orange only for primary action, selection, focus, or live execution.
- Distinguishes live work from finished work without reading a label.
- Defines how each state change moves, using the shared motion tokens.
- Includes loading, empty, error, disabled, and long-content states where relevant.
- Meets keyboard, focus, contrast, reduced-motion, and non-color-cue requirements.
- Introduces a documented design-system decision before implementation when no existing rule applies.

## Changelog

### 2026-10-08 - Lively visual direction

- Replaced the Linear-inspired calm, flat, border-first direction with a lively, fluid direction: warm neutrals, persimmon-orange brand from the WorkLite mark, soft four-level elevation, larger radii, and moderately relaxed density with `38px` standard controls.
- Added shared motion tokens and required motion for press, overlays, disclosures, selection indicators, list entry, route content, status changes, and streaming, with reduced-motion equivalents.
- Required field-anchored overlays to match their trigger width and single-line controls to truncate rather than wrap.
- Defined live-execution visibility: running work uses the brand live dot and halo, is grouped and pinned in collections, and finished work settles into a quiet state.
- Unified tabs into one sliding-underline style and segmented controls into one sliding-pill style.
- Added optimistic updates for reversible mutations and toasts for transient outcomes.

### 2026-09-24 - Run execution graph

- Replaced the Run node list as the primary overview with the immutable Workflow version graph, execution status on nodes, and traversed or skipped state on edges.
- Kept execution order in a chronological trace and preserved node input, activity, output, failure, and retry details in a node-selected dock.

### 2026-09-23 - Contextual Workflow node picker

- Made the Workflow inspector selection-driven and moved node creation into a floating picker opened from the toolbar or a blank-canvas connection drop.

### 2026-09-23 - Workflow bottom inspector

- Moved selected Workflow node and edge details below the diagram, with an independent scroll region at every breakpoint.

### 2026-09-23 - WeChat article output

- Defined a restrained Mint Cyan article style for the external WeChat reading surface, including semantic heading hierarchy, indented paragraphs, neutral code blocks, and same-family table accents.

### 2026-09-23 - Workflow canvas readability

- Replaced parameter-heavy canvas cards with compact stage nodes and moved detailed configuration into the inspector.
- Added direct-connection emphasis, reduced-motion directional selection feedback, concise condition labels, and explicit graph alignment while keeping execution state distinct from selection.

### 2026-09-23 - Workflow canvas navigation

- Applied the left-to-right dependency layout when an existing graph loads and fit the viewport after asynchronous node hydration.
- Made horizontal wheel navigation and two-axis canvas dragging explicit; the fit scale has a readable minimum so wide workflows can be panned instead of shrinking node cards to fit.

### 2026-09-23 - Workflow diagram navigation

- Replaced the transformed React Flow canvas model with fixed-scale HTML nodes, SVG connections, deterministic automatic layout, and native two-axis scrolling.
- Kept ordinary wheel input vertical and assigned horizontal trackpad gestures and Shift+wheel to horizontal navigation; removed canvas panning, zooming, node dragging, and manual alignment.

### 2026-09-23 - Workflow coordinate layout

- Set node `x` from the dependency column and node `y` from a symmetric lane formula, with mean incoming-source topological order and definition order resolving parallel nodes deterministically.
- Recompute node positions on graph topology changes so additions, removals, and route changes do not leave coordinates dependent on stale positions.

### 2026-09-22 - Paused Workflow Run

- Added `paused` as a warning status with a non-color pause cue, visually distinct from durable `waiting_for_input` and neutral cancelled execution.
- Added reversible Run pause and resume controls with control-local progress and retained Run-detail cancellation for paused Runs.

### 2026-09-21 - Conversational turn and queue

- Defined one Agent turn as one identity block containing its own Skill-call rows, and reduced working, cancelled, and failure cues to inline notes without identity marks while keeping them independent status regions.
- Replaced the discarded-draft behavior with a visible removable message queue for input submitted during a running turn, on the grounds that accepting a keystroke and dropping it reports work the product did not do. This supersedes the 2026-08-27 omission of message queuing.
- Required a return-to-end control on streaming conversational surfaces whenever the reader is away from the end.
- Replaced the remaining `System Helper Chat` references with `Chat Bot`.

### 2026-09-19 - Implementation

- Applied the single-action rule to the surfaces that violated it: the Run pending-action QR and the WeChat Official Account QR now replace themselves, provider testing starts without a second confirmation when the model is resolvable, MCP `Save` absorbs its connection handshake, and the duplicated Codex quota refresh is gone.
- Recorded two documented exceptions where staleness is not observable: the WeChat ClawBot connection exposes no expiry, and per-account Codex refresh forces an OAuth token refresh rather than re-reading a polled snapshot.
- Applied the copy standards across both locales, removing restated headings, component-duplicating hints, and the strings that only supported the manual paths now automated.

### 2026-09-19

- Added the One action per goal and Text earns its place principles, governed in detail by `ui-ux-design/shared/interaction-contract.md` and `ui-ux-design/shared/copy-standards.md`.
- Prohibited preparation-plus-commit control pairs for a single goal and restricted manual refresh controls to values whose staleness the product cannot observe.
- Required action progress to appear on the activated control rather than on the surrounding region.
- Replaced the pending-action panel's QR expiry time and manual refresh with automatic replacement and a status line, keeping `Cancel run` as a separate intent.
- Required page and section descriptions to justify themselves as a constraint or a scope bound rather than existing by default.

### 2026-09-18

- Added a neutral per-node `Retry node` recovery control to retryable failed node log entries, scoped to the single retryable entry rather than the Run level.
- Kept retry non-destructive and non-primary: neutral styling with icon and text cues, a control-local busy state, and preserved failure text until execution continues.

### 2026-09-16

- Added the pending Workflow authentication panel for login and publish-confirmation QR actions.
- Kept waiting states amber and neutral, reserving brand blue for the active refresh action and focus.

### 2026-09-15

- Added the Chat Workflow Mentions pattern for distinguishing Agent turns from published Workflow Runs and for presenting Run progress and Artifacts in the embedded chat transcript.

### 2026-09-15

- Added ordered node execution logs and directly visible failure reasons to expanded Workflow Run records.
- Limited Artifact disclosure and its empty state to immutable Workflow versions that contain an Artifact node.

### 2026-09-15

- Added the Workflow Artifact node using the existing neutral node grammar and shared selection, focus, and execution treatments; no new color, icon, or layout language was introduced.

### 2026-09-15

- Moved Run records into a per-Workflow Workflow List dialog while preserving neutral execution states, canonical status labels, and inline Artifact disclosure.

### 2026-09-14

- Added a neutral application-version label to the compact sidebar preferences control, keeping version metadata visible without adding a navigation destination or color emphasis.
- Grouped primary navigation into Workspace, Capabilities, and Configuration sections with seven concise destinations: Home, Workflows, Runs, Agents, Plugins, Providers, and Settings.
- Kept related Agent resources and Run-produced Artifacts behind stable page contexts rather than expanding the primary sidebar.
- Reaffirmed that destructive styling is reserved for permanent removal and cancellation is a neutral execution control.

### 2026-09-08

- Adopted Memory One as the full WorkLite visual direction across all web surfaces: cold-white and blue-black themes, compact three-column workspace geometry, flat neutral surfaces with crisp borders, restrained blue reserved for primary action and execution, and lightweight tabbed configuration panels.
- Standardized this direction as a global implementation decision rather than a page-specific reference, so collections, editors, settings, runs, integrations, onboarding, and chat share the same visual grammar.

### 2026-09-07

- Adopted the Memory One visual reference for the shared WorkLite shell: a restrained blue accent, compact neutral surfaces, restrained borders, and lightweight interaction feedback. Execution and status colors remain semantically distinct; brand color is reserved for primary actions, selection, focus, and active execution.

### 2026-09-01

- Combined the node palette and contextual inspector into one right-side panel that switches content based on canvas selection.
- Required synchronized graph and panel selection, node-local selected and keyboard-focus states, visible port labels, and theme-aware canvas primitives.

### 2026-08-31

- Replaced the ordered workflow sequence with a node canvas supporting explicit edges, persisted layout, panning, zooming, and fit-to-view.
- Required inline Text editing, restrained handle and edge semantics, and an accessible inspector path for graph review and deletion.
- Selected `@xyflow/react` for the workflow editor; React-rendered nodes handle direct Text editing while the inspector remains the full keyboard-accessible path.

### 2026-08-29

- Reaffirmed mobile object-row collections, reachable compact view navigation, validation-message associations, and conditional stream following for the reliability pass.
- Required integration and workflow editor surfaces to represent only server-backed tests, tools, edits, versions, and logs.

### 2026-08-29

- Adopted a ComfyUI-inspired three-region workflow workspace while retaining the ordered linear execution model.
- Added an agent palette, persistent responsive inspector, explicit insertion positions, and grouped workflow-level settings.
- Extended workflow surfaces to Workflow Input, Text, Skill Set, and named-port Generic Agent nodes with immutable AgentVersion context and file Artifact output states.

### 2026-08-28

- Kept selected Agent mentions inline with task text inside one composer input surface.
- Added structured `@` Agent selection, removable mention tokens, and a compact persistent child-session band for Chat Bot.
- Adopted Vercel AI Elements' compositional Conversation, Message, and Prompt Input pattern for Chat Bot while retaining WorkLite's semantic tokens, persisted execution state, and shared safe Markdown renderer.

### 2026-08-27

- Unified interactive component states around a single crisp boundary, a soft gapless focus halo, restrained hover contrast, and consistent invalid and disabled behavior.
- Made inline Skill calls compact and collapsed by default, with status and exit context retained in the summary and bounded details available on demand.
- Added transcript-owned Agent working placeholders, editable drafts during execution, and a neutral Stop control that replaces Send for active turns.

### 2026-08-26

- Added the shared streaming Markdown response pattern for current and future Agent output.
- Defined right-aligned plain-text user messages, left-aligned unframed Agent responses, secure Markdown handling, and conditional stream following.

### 2026-08-24

- Adopted the provided orange robot outline as the WorkLite brand mark.
- Added transparent responsive PNG assets and browser icon variants.

### 2026-08-25

- Reframed the product UI as a single-user personal workspace.
- Removed team switchers, member administration, account entry surfaces, and team-specific language from the shared visual model.
- Kept the same dual-theme tokens, execution semantics, resource density, and accessible interaction requirements.

### 2026-08-14

- Integrated the internationalization standard into UI copy, layout, and accessibility requirements.

### 2026-08-13

- Established the WorkLite UI design system as the source of truth for interface changes.
- Defined a Linear-inspired professional workspace with equal light and dark theme support.
- Selected persimmon orange as the restrained brand, focus, selection, and execution color.
- Defined foundational guidance for color, typography, spacing, shape, components, agents, workflows, runs, motion, and accessibility.
- Aligned the workflow editor with the initial ordered-step architecture and removed free-form graph-canvas guidance.
- Added the UI implementation specification as the companion source of truth for page-level work.
