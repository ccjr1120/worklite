# Agent Team Group

## Route

`/agent-team-groups/:groupId`

## Design Source

- `docs/ui-design-system/README.md`
- `ui-ux-design/shared/workspace-shell.md`
- `ui-ux-design/shared/page-patterns.md`
- `ui-ux-design/shared/shared-states.md`
- `ui-ux-design/shared/interaction-contract.md`
- `ui-ux-design/shared/copy-standards.md`
- `ui-ux-design/shared/responsive-behavior.md`
- `ui-ux-design/pages/chat/workspace/DESIGN.md`
- `ui-ux-design/pages/agent-teams/detail/DESIGN.md`

## Implementation

- `apps/web/src/routes/agent-team-groups/$groupId.tsx`
- `apps/web/src/features/agent-teams/group-chat.tsx`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/queries.ts`

## Purpose

Read an existing Team group transcript as an archived history. Chat owns all current Team work.

## Primary Task

Read the persisted transcript and follow a Run link to its immutable execution evidence. Action budget: one group selection. This route is read-only and cannot continue or change a group.

## Layout

Use the shared detail width up to 1200px. The page heading shows the group title, a concise archive explanation, and a Chat link. A transcript section lists persisted messages in sequence with sender, recipient role when present, timestamp, Markdown body, a Run link when bound, and referenced document title/revision. A second section lists associated Runs with status, intent, addressed role and a link to read-only evidence. The page is an archive, not a continuation surface.

Messages use neutral bordered rows, not role-addressing chat bubbles. Sender and recipient roles are rendered as text, and message bodies use the shared safe Markdown renderer. Document references are shown by title and revision. The persisted group query refreshes automatically and group events invalidate its snapshot.

Run references in the transcript link to read-only Run detail. Current status and execution activity belong to the Run evidence route and Chat task card; this archive does not render controls or update actions. Team configuration and memory management live in Chat.

The archived transcript has no composer or pending-question form. A question and answer already stored in history remain visible as transcript entries. The route offers no role-addressing, repository mutation, Team administration, Run control, or direct answer affordance.

## Interaction Contract

| Action | Behavior |
| --- | --- |
| Read transcript | Open the group archive from an existing history link. |
| Open Run evidence | Follow a Run reference to `/agent-team-runs/:runId`. |
| Operate Team work | Navigate to Chat; Chat owns group dispatch, pending-input answers, exact Command grants, Run controls, and Team configuration. |

The persisted group query owns archive content. This route does not subscribe for controls or accept mutations.

## States

| State | Behavior |
| --- | --- |
| Loading | Shared content-shaped placeholders retain the header and transcript geometry. |
| Empty archive | Show the shared empty-history state and a link to Chat for new Team work. |
| Archived history | Render persisted messages and status entries read-only; Run references open immutable evidence. |
| Error | Show the shared recoverable load error. |
| Busy | No mutation controls are present. |
| Offline | Show the shared recoverable load error when the archive query cannot refresh. |
| Long content | Render safe Markdown in messages; open Run detail for execution activity, command output and document content. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `agentTeams:group.archive` / `archiveDescription` / `archiveEmpty` | State |
| `agentTeams:group.untitled` / `transcript` / `boundRuns` | State |
| `agentTeams:group.you` / `system` / `recipientLabel` / `unspecifiedRole` | State |
| `agentTeams:group.openChat` / `openRun` | Action |
| `agentTeams:group.noRuns` | State |
| `agentTeams:group.loadFailed` | Recovery |
| `agentTeams:run.status.*` / `role.*` | State |

## Accessibility

Sender and recipient roles, timestamps, Run links and document references are visible as text. Chat and Run links are keyboard reachable with visible focus. Status badges include text labels, and both themes inherit shared components.

## Coverage Status

Verified 2026-10-20. Differences found: the page has no composer, recipient menu, directory editor, Team administration, answer form or Run controls; direct group creation, message, answer and repository-mutation API routes are also retired. It reads the archived transcript, displays message sender/recipient and document references, and links bound messages and Runs to read-only evidence. The associated Run list shows status and target role. Repository labels, a return-to-end control and direct document links are not rendered. This was a source review; no runtime or browser verification was run.

## Changelog

### 2026-10-20

- Retired direct group chat. Existing group transcripts remain read-only archives; Chat owns new Team messages, questions, controls and administration.

### 2026-10-19

- Listed the protected Team Manager first in the `@` role menu and returned keyboard focus to the composer after a role selection.

### 2026-10-19

- Replaced the composer-top task band with transcript-inlined Run status cards following the Chat grammar; removed the role-wide batch controls and the working-practice line, and moved the add-directory action into the composer.
- Posted graph-level Run failures into the group transcript as system status messages, and made an unconfigured Team Manager model fail fast with a clear error; the Team Manager model selector is editable in Team configuration.

### 2026-10-19

- Added the protected in-group Team Manager as a narrowed Chat Agent for Team configuration, role CRUD and Team memory operations.
- Made the `@` recipient menu and work-role context dynamic while preserving immutable role snapshots on accepted Runs.

### 2026-10-19

- Adopted the Chat conversation grammar: full-height transcript, floating composer with `@` role mention token, in-transcript question cards, return-to-end control, and a compressed Run task band replacing the repository/Run/working-practice side panel.
- Removed the repository precondition from sending: unscoped messages create empty-scope Runs, and directories bind through role-identified `repositoryDirectories` or answer-carried `directories`; the per-message repository checkboxes are removed in favour of the server's default group scope.
- Routed the working-practice action to the separate Team configuration page.
