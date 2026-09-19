# Artifact Details

## Route

`/artifacts/:artifactId`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/artifacts/$artifactId.tsx`

## Purpose

Read the content a Workflow Run produced, and take it out of the product when needed.

## Purpose of the Preview

Use the safest appropriate preview. Text and structured data receive readable viewers with copy or download. Supported media receives a constrained preview and metadata. Unsupported or potentially unsafe content receives metadata and no inline execution.

## Primary Task

Read the Artifact's content. Action budget: zero — the content renders on arrival. Downloading costs one action; deleting costs two, and the second is the confirmation that permanent removal requires.

## Layout

Details width up to `1200px`. The context bar carries the Artifact name as its breadcrumb, a destructive delete icon, and the download action. The page heading repeats the name with type and size as its secondary line. A metadata row below it carries the copyable Artifact identifier, the producing Workflow name, the producing Run identifier, and the creation time. The content region is a bordered surface with the payload in a monospace block.

Run provenance is context, not navigation: standalone Run routes no longer exist, so the Workflow remains directly addressable while the Run identifier is displayed as plain text.

## Interaction Contract

Download builds a file from the Artifact's own `content` and `type` — `json`, `text`, or `markdown` map to their media types — and names it from the Artifact name. The browser's own download indicator is the completion signal, so no toast is shown. A failure to construct the file reports next to the action.

For `type === 'unsupported'` the download control is not rendered at all. There is no inline-previewable content and no payload to write, so an action that cannot succeed must not be offered; the inline message states that the content cannot be previewed.

Delete opens the shared named confirmation. Confirming reports busy on the confirm control, and success closes the dialog, shows the outcome, and returns to the Workflow collection. Failure keeps the dialog open with the reason visible until the user recovers or dismisses it. This is the one action on this surface that keeps a second step: permanent removal is the case `shared/interaction-contract.md` reserves confirmation for.

Copying the Artifact identifier reports on the copy control itself.

Nothing here is self-healing. An Artifact is immutable once written, so its content cannot go stale and no poll exists.

## States

| State | Behavior |
| --- | --- |
| Loading | Content-shaped skeleton for the heading, metadata row, and content region. Loading is never presented as absence. |
| Empty | An Artifact with empty content states that the Run produced no content, distinct from a missing Artifact. |
| No results | Not applicable. |
| Error | Two distinct cases. A load failure explains the failure and offers a retry. A genuinely missing, expired, or inaccessible Artifact states that instead, without leaking why it is protected. |
| Busy | Download reports on the download control; delete reports on the confirmation's confirm control. |
| Offline | Inherits `shared-states.md`. |
| Long content | Large content loads without blocking the shell and scrolls within its own region. Untrusted content renders as text and is never executed. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `artifacts:details.loading` | State |
| `artifacts:details.loadFailedTitle` | State |
| `artifacts:details.loadFailed` | Recovery |
| `artifacts:details.unavailableTitle` | State |
| `artifacts:details.unavailableDescription` | State |
| `artifacts:details.emptyContent` | State |
| `artifacts:details.unsupported` | Constraint |
| `artifacts:details.run` | State |
| `artifacts:details.noRun` | State |
| `artifacts:delete.title` | State |
| `artifacts:delete.description` | Constraint |
| `artifacts:delete.action` | Action |
| `artifacts:delete.deleting` | State |
| `artifacts:delete.success` | State |
| `artifacts:delete.failed` | Recovery |
| `common:actions.download` | Action |
| `common:actions.cancel` | Action |
| `common:copy.identifier` | Action |

`artifacts:details.downloadStarted` is removed. A real download is reported by the browser's own download indicator, so a success toast asserting that a download started is both redundant and — in the current implementation, where nothing is downloaded — false.

`artifacts:details.unsupported` keeps its first clause as a Constraint and drops its `Download the file instead.` instruction, because no download control is rendered for unsupported content.

`artifacts:details.run` takes the Run identifier as `{{value}}` so the metadata row labels it instead of printing a bare string, and `artifacts:details.noRun` covers a detached Artifact.

## Accessibility

The delete control is icon-only and carries both an accessible name and a title naming the Artifact. The download control is a labeled button. The confirmation dialog traps focus, returns it to the invoking control on dismissal, and associates its failure text with the dialog. The copyable identifier exposes its copy action by name. Type and size are text, never color-encoded.

## Coverage Status

Verified 2026-09-19, resolved 2026-09-19 in the state-completeness pass. The differences found and their resolution:

- Download was not implemented; the control only called `toast.success(t('details.downloadStarted'))`, reporting success for an operation that never happened. Resolved: the control now builds a Blob from `ArtifactView.content` with a media type and file extension derived from `type`, and no API change was needed.
- The download control was rendered for `type === 'unsupported'`, where there is no content to write. Resolved: the control is absent for that type.
- Loading was presented as not-found. `if (!artifact)` rendered the `details.unavailableTitle` heading, so every visit read "Artifact unavailable" while the query was pending, and `isLoading`/`isError` were never consulted. Resolved: loading, load failure, and a genuinely missing Artifact are now three separate branches.
- The unavailable branch rendered a bare `PageHeading` with no `WorkspaceChrome`, so the breadcrumb vanished and the shell shifted. Resolved: all three non-content branches keep the chrome and the collection breadcrumb.
- `artifacts:details.noRun` and `artifacts:details.run` were defined but never rendered; the Run identifier printed as a bare unlabeled string. Resolved: the metadata row labels the Run identifier and falls back to the detached-Run string.

Remaining difference: an Artifact whose content is empty now reports that explicitly, but the API does not distinguish "produced no content" from "content withheld", so the state is inferred from an empty `content` string.

## Changelog

### 2026-09-19 - Copy cleanup

- Removed `artifacts:description` from both locales as a definition of the object rather than guidance.

### 2026-09-19 - State completeness

- Implemented the real download from `ArtifactView.content`, removed the false success toast, and hid the download control for unsupported content.
- Separated loading, load failure, and missing Artifact into three states, each retaining the workspace chrome.
- Labelled the Run identifier in the metadata row and added an explicit empty-content state.

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Required a real download built from the Artifact's own content and type, and removed the `downloadStarted` toast as false feedback.
- Removed the download control for unsupported content, which has no payload to write.
- Required loading, genuinely-unavailable, and load-failure to be three distinct states rather than one not-found message.

### 2026-09-15

- Replaced producing-Run navigation with non-navigation Run provenance and returned Artifact deletion to the Workflow collection after standalone Run routes were removed.

### 2026-09-14

- Updated deletion navigation to the producing Run context after removal of the standalone Artifact list route.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.

### 2026-08-13

- Established the Artifact Details specification.
