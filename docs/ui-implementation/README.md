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

- Authentication: [Sign in](auth/sign-in.md), [Sign up](auth/sign-up.md), [Email verification](auth/email-verification.md), [Password recovery](auth/password-recovery.md), [Invitation](auth/invitation.md)
- [Onboarding](onboarding/README.md)
- [Home](home/README.md)
- [Workspace Agent Chat](assistant/README.md)
- Agents: [List and resource views](agents/list.md), [Editor](agents/editor.md), [Model providers](model-providers.md)
- Workflows: [List](workflows/list.md), [Editor](workflows/editor.md), [Versions](workflows/versions.md)
- Runs: [List](runs/list.md), [Details](runs/details.md)
- Skills: [List](skills/list.md), [Editor](skills/editor.md)
- MCP servers: [List](mcp-servers/list.md), [Configuration](mcp-servers/configuration.md)
- Artifacts: [List](artifacts/list.md), [Details](artifacts/details.md)
- Settings: [General](settings/general.md), [Members](settings/members.md), [Usage](settings/usage.md), [Audit log](settings/audit-log.md), [Appearance](settings/appearance.md)

## Route Map

```text
/sign-in  /sign-up  /verify-email  /forgot-password  /reset-password
/invite/:token
/onboarding/{team,provider,first-agent}
/:teamSlug/home
/:teamSlug/assistant  -> redirects to /:teamSlug/home with Agent Chat expanded
/:teamSlug/agents/{new,:agentId}
/:teamSlug/model-providers
/:teamSlug/workflows/{new,:workflowId,:workflowId/versions}
/:teamSlug/runs/:runId
/:teamSlug/skills/{new,:skillId}
/:teamSlug/mcp-servers/{new,:serverId}
/:teamSlug/artifacts/:artifactId
/:teamSlug/settings/{general,members,usage,audit-log,appearance}
```

Authentication redirects preserve the intended destination. Team routes verify membership and show explicit missing-team or access states.

## Shared Component Inventory

Theme provider and appearance selector; application shell; sidebar; team switcher; context bar; user and command menus; shell-level team Agent Chat; page heading; form controls and messages; status badge; search, filters, object rows and tables; dialogs and sheets; save indicator; inspector; resizable log panel; ordered workflow steps; run timeline; viewers for logs, output and artifacts; skeletons, errors, permission states and offline banner.

Domain-neutral reusable components belong in the shared UI package. Feature composition remains near its feature. Abstract only demonstrated repeated patterns.

## Implementation Sequence

1. Foundations: semantic dual-theme tokens, initial theme resolution, typography, focus, motion, controls and feedback.
2. Authentication: shell, account flows, recovery and invitations.
3. Workspace shell: navigation, context bar, menus and responsive behavior.
4. Home and collections: Home states and shared collection grammar.
5. Editors and execution: Agent editor, ordered Workflow editor, Runs, logs and artifacts.
6. Integrations and administration: Skills, MCP servers and Settings.

Every phase includes both themes, keyboard behavior, loading and failure states.

## Changelog

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
