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

## Page and Surface Specifications

- [Home](pages/home/DESIGN.md), including the server-derived first-use sequence
- [Workspace System Helper Chat](surfaces/workspace/system-helper-chat/DESIGN.md)
- Agents: [List](pages/agents/list/DESIGN.md), [Editor](pages/agents/editor/DESIGN.md)
- Providers: [Model providers and Portkey Gateway](pages/model-providers/DESIGN.md), including the dedicated Codex Account Pool and Gateway request statistics
- Workflows: [List](pages/workflows/list/DESIGN.md), [Editor](pages/workflows/editor/DESIGN.md), [Versions](pages/workflows/versions/DESIGN.md)
- Skills: [List](pages/skills/list/DESIGN.md), [Editor](pages/skills/editor/DESIGN.md)
- MCP servers: [List](pages/mcp-servers/list/DESIGN.md), [Configuration](pages/mcp-servers/configuration/DESIGN.md)
- Plugins: [List](pages/plugins/list/DESIGN.md), [Configuration](pages/plugins/configuration/DESIGN.md)
- Artifacts: [Run artifacts](surfaces/workflow-run/artifacts/DESIGN.md), [Details](pages/artifacts/details/DESIGN.md)
- Settings: [Usage](pages/settings/usage/DESIGN.md), [Audit log](pages/settings/audit-log/DESIGN.md), [Diagnostic logs](pages/settings/diagnostic-logs/DESIGN.md), [Appearance](pages/settings/appearance/DESIGN.md)

## Route Map

```text
/home
/agents/{new,:agentId}
/model-providers
/workflows/{new,:workflowId,:workflowId/versions}
/skills/{new,:skillId}
/mcp-servers/{new,:serverId}
/plugins
/plugins/:pluginId
/artifacts/:artifactId
/settings/{usage,audit-log,logs,appearance}
```

The root route opens Home. `/settings/` opens Appearance. Route layouts and redirects are governed by the shared Workspace shell rather than separate page specifications.

There is no `/onboarding` route family. First use is a server-derived sequence inside Home, so a separate browser-state onboarding flow would duplicate it with a less reliable completion signal.

The `/model-providers` page is the top-level Providers destination. It uses page-level tabs for Model Providers, the dedicated Codex Account Pool, and Gateway Statistics; the Gateway summary remains on the Model Providers view.

## Shared Component Inventory

Theme provider and appearance selector; application shell; router pending and error boundaries; sidebar; context bar; personal preferences menu; command menu; shell-level System Helper Chat with plugin picker; shared streaming Markdown response renderer; page heading; form controls and messages; status badge; search, filters, object rows and tables; dialogs and sheets; save indicator; inspector; resizable log panel; React Flow workflow graph canvas; workflow run history dialog; run timeline; plugin configuration; viewers for diagnostic logs, run output and artifacts; skeletons, errors, offline banner.

Domain-neutral reusable components belong in the shared UI package. Feature composition remains near its feature. Abstract only demonstrated repeated patterns.

## Implementation Sequence

1. Foundations: semantic dual-theme tokens, initial theme resolution, typography, focus, motion, controls and feedback.
2. Personal workspace shell: navigation, context bar, menus and responsive behavior.
3. Home and collections: Home states and shared collection grammar.
4. Editors and execution: Agent editor, Workflow graph editor, Workflow run history, logs and artifacts.
5. Integrations and preferences: Skills, MCP servers and Settings.

Every phase includes both themes, keyboard behavior, loading and failure states.

## Changelog

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
- Added resumable System Helper Chat sessions and slash-command completions.

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

- Refined Agents and Workflow editor layout and run-history surfaces.

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

- Moved Skills, MCP Servers, and Providers from the sidebar subgroup into shared tabs on the four Agent resource collection pages; Plugins remains first-level navigation.
- Unified workspace and Agent resource navigation into one hierarchical sidebar, with Plugins beside Agents and Skills, MCP Servers, and Providers beneath Agents.

### 2026-08-27

- Reduced the Home first-use checklist to Model Provider configuration and System Helper Chat model binding, with completion derived from persisted resource state.
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
