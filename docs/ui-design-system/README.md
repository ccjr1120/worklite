# WorkLite UI Design System

This document is the source of truth for WorkLite user-interface principles and visual language. `docs/ui-implementation/README.md` defines page structure, shared UI architecture, implementation sequencing, and page-level acceptance criteria. Every UI proposal and implementation must follow both documents through the UI Change Workflow in `AGENTS_WORKFLOW.md`.

## Product Character

WorkLite is a professional personal workspace for creating and running AI agents and workflows. Its interface should feel calm, precise, focused, and warm.

The visual direction is inspired by the clarity and efficiency of Linear without copying its brand. WorkLite establishes its own identity through persimmon orange, execution-oriented interaction patterns, and a consistent visual language for agents, workflows, and runs.

The interface must:

- Prioritize clarity, scanability, and control over decoration.
- Support efficient, sustained use at moderate-to-high information density.
- Communicate AI behavior through observable state and feedback rather than visual spectacle.
- Feel lighter than a traditional enterprise dashboard and more dependable than a novelty AI interface.
- Treat light and dark modes as equally important, deliberately designed experiences.

The WorkLite brand mark is the orange robot outline in `apps/web/public/brand/worklite-logo.png`. Use the transparent asset through the shared `WorkLiteMark` component for product-owned branding, onboarding, and browser icons. Do not recreate the mark with a substitute icon or apply a background that reduces its legibility.

## Design Principles

1. **Calm by default.** Neutral surfaces dominate; color is reserved for meaning and action.
2. **Precise hierarchy.** Typography, spacing, borders, and surface contrast establish structure before shadows or decoration.
3. **Visible execution.** Users can understand what is running, waiting, completed, or failed.
4. **Progressive disclosure.** Common actions remain immediate while advanced configuration stays available without overwhelming the primary flow.
5. **Consistent semantics.** The same color, component, and motion meaning applies throughout the product.
6. **Accessible interaction.** Keyboard access, visible focus, sufficient contrast, and non-color cues are baseline requirements.

## Color System

All implementation colors must be exposed through semantic design tokens. Raw color values must not be repeated in page or feature code.

### Core Neutrals and Brand

| Token | Light mode | Dark mode | Purpose |
| --- | --- | --- | --- |
| `background` | `#F7F8FA` | `#101216` | Application background |
| `surface` | `#FFFFFF` | `#171A20` | Primary content surface |
| `surface-raised` | `#FFFFFF` | `#1C2027` | Menus, dialogs, and elevated panels |
| `surface-subtle` | `#F1F3F5` | `#1D2128` | Secondary and selected-neutral surfaces |
| `text-primary` | `#202126` | `#ECEEF2` | Primary text |
| `text-secondary` | `#6F747E` | `#989FAA` | Supporting text |
| `border` | `#E4E6EA` | `rgba(255, 255, 255, 0.09)` | Standard boundaries |
| `brand` | `#DC5F2B` | `#F47B45` | Primary action and brand emphasis |
| `brand-hover` | `#C95021` | `#F68D5E` | Brand control hover |
| `brand-active` | `#B9471C` | `#DC6738` | Brand control active state |
| `brand-subtle` | `#FFF0E9` | `rgba(244, 123, 69, 0.14)` | Selection and restrained emphasis |

Persimmon orange is the signature color. It represents primary action, current focus, selection, and active execution. It must not be applied indiscriminately to headings, icons, large backgrounds, or ordinary content.

### Semantic Status Colors

Brand color must not replace status meaning.

- **Running:** persimmon orange plus a text or icon cue.
- **Success and completed:** green.
- **Warning and paused:** amber or yellow, visually distinct from brand orange.
- **Error and failed:** red.
- **Information:** cool blue.
- **Queued, cancelled, and inactive:** neutral gray.

Every status must use at least one non-color cue, such as an icon, label, shape, or motion pattern.

## Themes

WorkLite supports `System`, `Light`, and `Dark` appearance settings. The default is `System`, and an explicit user selection must persist.

- Resolve the theme before initial paint to prevent a light-theme flash.
- Set the browser `color-scheme` to match the active theme.
- Theme shared editors, charts, scrollbars, diagrams, illustrations, and floating surfaces with the application.
- Preserve the same hierarchy and semantic meanings across themes.
- Do not create dark mode through automatic color inversion.
- Use subtle transition timing and respect `prefers-reduced-motion`.

Light mode should feel crisp and open. Dark mode should feel focused and deep, using dark blue-gray rather than pure black.

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

Use concise, direct source copy and preserve the same meaning and tone in every supported locale. Avoid promotional language inside the application. Labels must describe actions or content without relying on placeholder text. Follow `docs/internationalization/README.md` for translation ownership, locale-aware formatting, text expansion, and accessible localized content.

## Spacing and Layout

Use a `4px` base spacing grid.

- Page padding: `24px`.
- Major section gap: `24px`.
- Standard panel padding: `16px`.
- Form-field gap: `16px`.
- Compact element gap: `8px`.
- Icon-to-label gap: `6px` to `8px`.
- Standard control height: `36px`.
- Compact control height: `28px` to `32px`.
- Top context bar height: `48px` to `52px`.
- Primary sidebar width: `220px` to `240px`.

The default application shell uses a stable sidebar, a compact context bar, a primary content region, and an optional contextual inspector. Logs or execution output may use a resizable lower panel when persistent visibility is valuable.

Responsive layouts must preserve task priority. Secondary inspectors may collapse into drawers, while primary actions and current state remain accessible.

## Shape, Borders, and Elevation

- Small controls: `6px` radius.
- Buttons and inputs: `8px` radius.
- Cards and panels: `10px` radius.
- Dialogs: `12px` radius.
- Status badges may use a pill shape.
- Standard borders are `1px`.

Use cards only when content is a distinct object or group. Avoid placing every section in a rounded container. Use shadows primarily for menus, dialogs, drag previews, and genuinely elevated content; prefer surface contrast and borders for ordinary hierarchy.

## Components

### Navigation

Keep navigation neutral. The selected item uses a subtle brand surface, stronger text, and optionally a narrow persimmon indicator. Do not fill the entire sidebar with brand color.

### Buttons

- **Primary:** solid persimmon orange for the most important action in the current context.
- **Secondary:** neutral fill or restrained border for supporting actions.
- **Ghost:** toolbars, inline actions, and low-emphasis controls.
- **Destructive:** red and reserved for genuinely destructive actions.

Prefer one primary action per visible region. Loading actions must respond immediately and preserve enough label context to explain what is happening.

### Forms

Keep labels visible above fields. Placeholder text provides examples only. Place help and validation messages next to the relevant field. Clearly communicate `Saving`, `Saved`, and `Unsaved changes` states. Group advanced configuration and disclose it progressively. Use dedicated editors for prompts, code, and structured data.

Form controls use one crisp boundary at rest. Hover may strengthen that boundary with neutral contrast, while keyboard focus replaces it with the brand-colored boundary and one soft, translucent halo without a gap. Do not stack an outline, border, and offset ring into multiple hard focus borders. Invalid controls use the same treatment with the error color. Disabled controls keep their boundary and surface legible without hover or active feedback.

Apply the same focus language to buttons, selection controls, tabs, menu items, and custom interactive rows. Borderless or inset interactions use one contained focus indicator that follows the component shape. Pointer, hover, active, focus, disabled, and invalid states must remain consistent across local and shared controls.

### Tables and Lists

Prefer compact lists or tables for agents, workflows, and runs when scanability matters. Use row heights around `44px` to `48px`, subdued headers, predictable sorting, visible filter chips, and on-hover secondary actions. Keep status near the object name. Truncated identifiers must be copyable. Distinguish an empty collection from a filtered result with no matches.

### Overlays and Feedback

Dialogs are for focused decisions, not routine navigation. Toasts communicate transient outcomes; important results and errors must remain visible in the page. Error feedback should explain the problem and provide a recovery action when one exists.

### Icons

Use Lucide icons consistently, normally at `16px` and at `18px` in primary navigation. Icon-only controls require an accessible name, tooltip, and an adequate interaction target. Emoji are not product icons.

## Product-Specific Patterns

### Agents

Present agents as configurable work units, not cartoon characters. Identity comes from a restrained geometric symbol or letter mark, name, responsibility, model, available skills or tools, ownership, version, and recent run state.

### AI Response Content

Use one shared streaming Markdown renderer for model-generated text across System Helper Chat and future Agent response surfaces. It must handle incomplete Markdown during streaming, GitHub Flavored Markdown, long words, tables, links, lists, quotations, and fenced code without executing embedded HTML or scripts. Product styling wraps the renderer and uses semantic tokens in both themes; transport parsing and conversation state do not belong inside the renderer.

In conversational layouts, user messages align to the right in compact neutral bubbles and remain plain text. Agent responses align to the left with a wider, unframed reading column so structured output remains scannable. Alignment, accessible labels, and optional identity marks distinguish speakers without relying on color. Streaming updates follow the end only when the reader was already at the end.

Create an Agent response placeholder in the transcript as soon as a turn starts. Show restrained inline progress there instead of replacing or disabling the composer. While a turn is running, keep the draft input editable and replace the send control with a familiar square Stop icon; stopping is a neutral execution control rather than a destructive action. Preserve the draft after completion or cancellation, and use text plus icon cues for working and cancelled states.

Present inline Skill calls as compact disclosure rows by default. The collapsed row keeps the Skill identity, script name, execution status, and exit code visible without allowing arguments, host details, or raw output to dominate the transcript. A keyboard-accessible disclosure control reveals the complete metadata, warning, and a height-bounded internally scrollable output region. Failed calls remain collapsed unless the user opens them.

Treat `@` selection in a conversation composer as structured dispatch, not decorated message text. Opening `@` presents a searchable keyboard-accessible custom-Agent menu with pointer selection, arrow navigation, `Enter`, and `Escape`. A selection becomes one removable mention token before the task text inside the same bordered input surface; it must not appear as a separate adjacent field or region. Only one Agent may be selected for a task, and its identity remains visible until dispatch or removal. The token and task text may wrap together within that shared surface on narrow screens.

Present persistent child Agent sessions in a compact unframed status band between the transcript and composer. Each item shows Agent identity and a text or icon status cue, with unread state communicated by more than color. Selecting an item switches the transcript and composer to that child conversation. Provide explicit return-to-System-Helper and close actions, use familiar Lucide icons with accessible names and tooltips, and keep the band compact and horizontally scrollable on narrow screens.

### Workflow Editor

- Represent the initial workflow model as a structured vertical sequence of ordered agent steps, not a free-form graph canvas.
- Use a three-region editor workspace: an agent palette for adding steps, a central ordered sequence, and a contextual inspector for the selected step.
- Keep step cards visually consistent and expose only essential parameters in their collapsed state.
- Add steps through an agent search/palette with an explicit insertion position between or after existing steps.
- Support reordering through accessible controls; do not depend on drag-and-drop.
- Keep the inspector available at every breakpoint; collapse it to a drawer or bottom sheet when the layout cannot support a side panel.
- Use persimmon borders or indicators for the selected and currently executing step.
- Represent successful and failed states through compact green or red markers rather than filling the whole step.
- Show the linear flow with a restrained connector or timeline treatment between steps.
- Present AI-assisted edits in a side panel and make proposed structured operations understandable and reviewable.
- Group workflow-level settings into General, Inputs, Execution, and Versioning sections, with advanced fields disclosed progressively.

Persimmon progression through the ordered steps is a distinctive WorkLite motif. It communicates active execution and must remain subtle enough for sustained use. Free-form edges, branching, loops, parallel lanes, zoom controls, and minimaps are outside the initial product scope.

### Runs and Logs

Use the following canonical run labels: `Queued`, `Running`, `Waiting for input`, `Completed`, `Failed`, and `Cancelled`.

Show the current step and continuing progress for long operations. Append logs without forcing disruptive scrolling. Use monospace text for raw output and allow users to distinguish timestamps, severity, source, and content. Successful completion should be clear but restrained; failure must include context and a next step where possible.

## Motion

- Hover feedback: approximately `120ms`.
- Tooltips and menus: approximately `150ms`.
- Panels and dialogs: `180ms` to `220ms`.
- Prefer natural ease-out curves.
- Avoid decorative page transitions, bounce effects, strong zoom, and large animated gradients.
- Use motion to clarify execution, selection, expansion, and state changes.
- Respect `prefers-reduced-motion` and retain static state cues when animation is disabled.

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

- Large areas of persimmon orange or decorative AI gradients.
- Glassmorphism, excessive glow, or pervasive shadows.
- Oversized marketing typography inside the application workspace.
- Excessive card nesting or large consumer-style rounded corners.
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
- Uses persimmon orange only for brand, focus, selection, or execution.
- Includes loading, empty, error, disabled, and long-content states where relevant.
- Meets keyboard, focus, contrast, reduced-motion, and non-color-cue requirements.
- Introduces a documented design-system decision before implementation when no existing rule applies.

## Changelog

### 2026-08-29

- Reaffirmed mobile object-row collections, reachable compact view navigation, validation-message associations, and conditional stream following for the reliability pass.
- Required integration and workflow editor surfaces to represent only server-backed tests, tools, edits, versions, and logs.

### 2026-08-29

- Adopted a ComfyUI-inspired three-region workflow workspace while retaining the ordered linear execution model.
- Added an agent palette, persistent responsive inspector, explicit insertion positions, and grouped workflow-level settings.
- Extended workflow surfaces to generic Text and Agent nodes, immutable AgentVersion context, and file Artifact output states.

### 2026-08-28

- Kept selected Agent mentions inline with task text inside one composer input surface.
- Added structured `@` Agent selection, removable mention tokens, and a compact persistent child-session band for System Helper Chat.
- Adopted Vercel AI Elements' compositional Conversation, Message, and Prompt Input pattern for System Helper Chat while retaining WorkLite's semantic tokens, persisted execution state, and shared safe Markdown renderer.

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
