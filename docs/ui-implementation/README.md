# WorkLite UI Implementation Index

## Governance

This directory is the source of truth for page structure, shared UI architecture, implementation sequencing, and page-level acceptance criteria. `../ui-design-system/README.md` remains the source of truth for visual language.

Before UI work, read the design system, this index, every applicable document under `shared/`, and every affected page document. Update affected documents and their changelogs before implementation when a decision changes. New pages require a specification first.

## Shared Specifications

- [Workspace shell](shared/workspace-shell.md)
- [Page patterns](shared/page-patterns.md)
- [Shared states](shared/shared-states.md)
- [Responsive behavior](shared/responsive-behavior.md)

## Page Specifications

- First-use setup: [Onboarding](onboarding/README.md)
- [Home](home/README.md)
- [Workspace System Helper Chat](assistant/README.md)
- Agents: [List and resource views](agents/list.md), [Editor](agents/editor.md)
- Providers: [Model providers and Portkey Gateway](model-providers.md)
- Workflows: [List](workflows/list.md), [Editor](workflows/editor.md), [Versions](workflows/versions.md)
- Runs: [List](runs/list.md), [Details](runs/details.md)
- Skills: [List](skills/list.md), [Editor](skills/editor.md)
- MCP servers: [List](mcp-servers/list.md), [Configuration](mcp-servers/configuration.md)
- Plugins: [List](plugins/list.md), [Configuration](plugins/configuration.md)
- Artifacts: [List](artifacts/list.md), [Details](artifacts/details.md)
- Settings: [Usage](settings/usage.md), [Audit log](settings/audit-log.md), [Diagnostic logs](settings/logs.md), [Appearance](settings/appearance.md)

## Route Map

```text
/home
/agents/{new,:agentId}
/model-providers
/workflows/{new,:workflowId,:workflowId/versions}
/runs/:runId
/skills/{new,:skillId}
/mcp-servers/{new,:serverId}
/plugins/:pluginId
/artifacts/:artifactId
/settings/{usage,audit-log,logs,appearance}
```

The root route opens Home. First-use setup is an optional checklist for configuring a Model Provider and binding that Provider and a model to System Helper Chat; there is no account, invitation, team, first custom Agent, Workflow, or Run setup step. The `/model-providers` page is the top-level Providers destination and switches between Model Providers and Portkey Gateway administration within the same page context.

## Shared Component Inventory

Theme provider and appearance selector; application shell; sidebar; context bar; personal preferences menu; command menu; shell-level System Helper Chat with plugin picker; shared streaming Markdown response renderer; page heading; form controls and messages; status badge; search, filters, object rows and tables; dialogs and sheets; save indicator; inspector; resizable log panel; React Flow workflow graph canvas; run timeline; plugin configuration; viewers for diagnostic logs, run output and artifacts; skeletons, errors, offline banner.

Domain-neutral reusable components belong in the shared UI package. Feature composition remains near its feature. Abstract only demonstrated repeated patterns.

## Implementation Sequence

1. Foundations: semantic dual-theme tokens, initial theme resolution, typography, focus, motion, controls and feedback.
2. Personal workspace shell: navigation, context bar, menus and responsive behavior.
3. Home and collections: Home states and shared collection grammar.
4. Editors and execution: Agent editor, Workflow graph editor, Runs, logs and artifacts.
5. Integrations and preferences: Skills, MCP servers and Settings.

Every phase includes both themes, keyboard behavior, loading and failure states.

## Changelog

### 2026-09-02

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
- Kept first-use provider and first-agent setup as an optional Home checklist.

### 2026-08-25

- Moved collection creation controls for Agents, Skills, MCP Servers, and Model Providers into the right side of the toolbar directly above each table or list.
- Added explicit Model Provider creation and confirmed deletion flows while preserving write-only credentials.

### 2026-08-25

- Consolidated sign-in and account creation into `/login` and removed the separate authentication routes without aliases.
- Defined authentication mode as URL state so links and refreshes preserve the selected form.

### 2026-08-24

- Kept Model Providers on the dedicated `/:teamSlug/model-providers` route while placing it as the final page-level view in the Agents surface, after MCP Servers.

### 2026-08-20

- Moved embedded Agent Chat ownership to the workspace shell so team-scoped sessions survive page and team navigation in browser memory.
- Merged Agent Chat into Home as an expandable workspace above a persistent composer.
- Retained the assistant route as a compatibility redirect that opens the embedded chat.
- Added the Agent Chat page specification and team-scoped assistant route.

### 2026-08-13

- Replaced the monolithic implementation specification with an indexed set of shared and page-specific documents.
- Preserved the approved route map, component inventory, and implementation sequence.
