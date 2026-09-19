# Artifact Run Card Presentation

## Route

`Not a standalone route; embedded in Workflow run records and run results.`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/features/workflows/run-history-dialog.tsx`
- `apps/web/src/components/workspace/agent-chat.tsx`

## Purpose

Show what a Run produced, where its output is, and how to open it.

## Primary Task

Open the Artifact a Run created. Action budget: one — activate the Artifact row, which navigates to `/artifacts/:artifactId`. The disclosure that reveals the rows belongs to the Run record, not to this surface.

## Structure

There is no standalone Artifact collection route or execution tab. Successful `worklite/artifact` node execution is the only source of Run-created Artifacts. They appear in two places: the expanded Run row inside the Workflow List Run records dialog, and the Workflow Run entry in the System Helper Chat transcript.

A Run-card Artifact row emphasizes name, type, useful size metadata, and creation time, with provenance available from its surrounding Run context. The name is the row's accessible link target.

The expanded Run row renders Artifact disclosure only when the Run's immutable Workflow version contains an Artifact node. A version that cannot produce Artifacts omits the section entirely rather than showing an empty one, so an empty state always means "this Run produced none" and never "this Workflow never could". Artifact deletion is not offered here; it remains on Artifact details.

## Layout

Inside the Run records dialog the Artifact section follows the ordered node logs, headed by an icon and label. Rows are bordered surfaces in a single column, widening to two columns at `lg`. Size and creation time use tabular numerals.

In the chat transcript the same Artifacts appear as compact entries within the Workflow Run card, subject to the transcript's narrower reading column.

## Interaction Contract

Activating a row navigates to Artifact details. Hover and focus use the shared neutral row treatment; the row is a single link target rather than a card with competing internal actions.

Artifact rows are not independently self-healing. They arrive with the Run detail query and refresh through the Run event stream that the enclosing Run record already subscribes to, so a newly written Artifact appears without asking. The section never polls on its own.

## States

| State | Behavior |
| --- | --- |
| Loading | While the Run detail query is pending, the section shows a restrained inline loading line with a non-color cue. |
| Empty | Reserved for eligible versions only: a version containing an Artifact node whose Run produced none says so. Ineligible versions render no section. |
| No results | Not applicable; this surface has no filters. |
| Error | A failed Run detail load explains the failure inline in the section without removing the node logs beside it. |
| Busy | Not applicable; this surface has no mutations. |
| Offline | Inherits `shared-states.md`. |
| Long content | A long Artifact collection scrolls within the dialog's own scrolling surface. Long names truncate with their complete value reachable. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `runs:artifacts` | State |
| `runs:artifactsLoading` | State |
| `runs:artifactsFailed` | Recovery |
| `runs:noArtifacts` | State |

Artifact names, types, and sizes are server-owned values rather than product copy and carry no keys.

## Accessibility

Each row is a link reachable by `Tab` with a visible focus ring, and its accessible name is the Artifact name. The section is labelled by its heading through `aria-labelledby`. The loading line pairs its spinner with text so the state is never conveyed by motion alone, and the spinner is `motion-safe` so reduced-motion users keep the static cue. Type and size are text, never color-encoded.

## Coverage Status

Verified 2026-09-19. Differences found against the implementation:

- `run-history-dialog.tsx` gates the section on `run.hasArtifactNode` and renders loading, failure, empty, and populated states as specified. No differences found there.
- `agent-chat.tsx` renders Run Artifacts as bare name links only (`run.artifacts.map` to a text link). It omits the type, size, and creation time this surface requires, and provides no loading, empty, or failure state for the Artifact portion of the Run card.
- The chat Workflow Run card shows Artifacts whenever `run.artifacts` is non-empty, with no equivalent of the `hasArtifactNode` eligibility rule, so the ineligible-versus-produced-none distinction exists only in the dialog.
- `ArtifactRow` in the dialog uses a bespoke `focus-visible:ring-brand/40` treatment rather than the shared `focusRing` token from `components/ui/interaction.ts`.

## Changelog

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding the action budget, the per-state table, the copy inventory, and verified coverage findings.
- Recorded that the chat transcript renders Artifacts without the type, size, and time metadata this surface requires, and without the version-eligibility rule the dialog applies.

### 2026-09-15

- Limited Run Artifact disclosure and its empty state to immutable Workflow versions that contain an Artifact node.

### 2026-09-15

- Defined successful Artifact-node execution as the source of Run-created Artifacts.

### 2026-09-15

- Moved expandable Run artifact presentation into the per-Workflow Run records dialog after removing standalone Run routes.

### 2026-09-14

- Removed the standalone Artifact list route and moved Artifact collection presentation into expandable Run cards.

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.

### 2026-08-13

- Established the Artifact List specification.
