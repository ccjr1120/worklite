# Skill Editor

## Route

`/skills/{new,:skillId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/skills/$skillId.tsx`

## Coverage Status

Migrated from the former indexed page specification. This change moved and indexed the specification; it did not audit implementation coverage.


## Layout

Every Skill detail uses the same editor workspace: a compact package tree on the left and the selected file viewer or editor in the remaining space. The tree renders only files returned by the API, derives folder nodes from their paths, and never hard-codes example entries. Empty directories are not shown. Use the shared monospace editor for current text files; introduce CodeMirror 6 only when a concrete editing requirement needs structured editing behavior.

Online user Skills support a required root `SKILL.md`, executable text files under `scripts/`, and text files under `references/`. New Skills begin with `SKILL.md`. A compact add-file icon exposes an inline relative-path field; deleting a selected non-root file requires an explicit action, while `SKILL.md` cannot be deleted. File paths and content use the typed package API and retain visible unsaved, saving, saved, path-validation, and durable error states. Folder-imported Skills use the same editable package surface and retain their archive source label. Binary assets, validation, and publication remain absent.

Saved script files with a Unix shebang expose a compact `Run` action in the selected-file header, including scripts in read-only built-in packages. A single-line JSON string-array field supplies exact arguments without shell parsing ambiguity. Direct execution uses the persisted package, so `Run` is disabled while an editable Skill has unsaved changes, while saving, or when the selected script lacks a shebang. Clicking `Run` starts the script immediately on the server without Agent assignment, a Model Provider, model selection, or a second approval step.

After a direct run starts, show an unframed output region below the editor with a non-color status badge, ordered stdout, stderr, and lifecycle labels, exit code or signal, reconnect state, and `Cancel` while active. Long uncapped output scrolls within the region and follows new events only while the user remains at the end. Browser navigation or event-stream disconnection does not stop the process. The editor clearly discloses that execution uses the API process's host permissions, current working directory, and complete environment. It does not expose interpreter, working-directory, environment, sandbox, timeout, output-limit, or host-access configuration fields.

Protected built-ins use the same package tree and file surface, with read-only content and no save, validate, publish, upload, or delete actions. Read-only executable files retain the same `Run`, argument, output, and cancellation controls as user Skill scripts. Built-in and assignment metadata appears compactly beside the tree or file header instead of replacing the package layout with a centered marketing or settings page.

For `terminal-command`, show its product-owned `scripts/run.sh`, built-in status, explicit per-Agent assignment, automatic Agent execution, API process working directory, `/bin/sh -lc`, and the non-sandbox host-permission warning. Do not present it as a special runtime capability. For `worklite-platform`, show its product-owned scripts and contract reference, built-in status, permanent System Helper Chat assignment, loopback API boundary, automatic script execution, secure credential rules, constrained client navigation, and the exclusion of external APIs, direct database access, deletion, terminal execution, editing, publication, and manual assignment.

Saved non-built-in Skills expose a destructive Delete action. Dependency conflicts remain visible in the named confirmation dialog; successful deletion returns to the Skill list.

## Changelog

### 2026-09-10

- Standardized resource deletion actions, named confirmation, success feedback, dependency errors, and navigation.


### 2026-09-10

- Added editable archive-source Skills created by folder import.

### 2026-08-29

- Set the current Skill editor baseline to the shared monospace editor and deferred CodeMirror 6 until a concrete structured-editing requirement exists.

### 2026-08-27

- Updated built-in Skill disclosure to describe automatic Agent execution instead of per-script approval.

### 2026-08-27

- Made `worklite-platform` a visible read-only executable package with product-owned scripts and a contract reference instead of a fixed runtime capability description.

### 2026-08-27

- Made the protected `terminal-command` package expose and directly run its product-owned `scripts/run.sh` through the same controls as every other executable Skill script.
- Removed terminal-specific capability presentation while retaining read-only package ownership and Agent-call approval disclosure.

### 2026-08-27

- Added direct execution for saved shebang-bearing user Skill scripts with exact JSON-array arguments, live persisted output, status, exit details, and cancellation.
- Kept all process ownership on the server and removed Agent, model, and second-approval requirements from the direct Skill-editor path.

### 2026-08-27

- Added real `scripts/` and textual `references/` package-file creation, editing, selection, and deletion.
- Required a Unix shebang for executable scripts and kept execution exclusively in assigned Agent approval flows.
- Added derived folder nodes and prohibited invented empty directories, binary assets, archive upload, validation, and publication.

### 2026-08-27

- Unified user and built-in Skill details under the package-tree and selected-file layout.
- Required API-backed files only, removed hard-coded examples and centered built-in detail pages, and hid archive upload, validation, and publication until real.
- Added real online Skill name and `SKILL.md` saving while retaining read-only protected built-ins.

### 2026-08-26

- Added the read-only `worklite-platform` capability and its fixed assignment, confirmation, and security boundaries. The later unified package-layout decision supersedes its original standalone detail presentation.

### 2026-08-26

- Replaced the opt-in host configuration state with automatic Unix availability and API-process working-directory disclosure.

### 2026-08-26

- Initially added an opt-in read-only terminal Skill state; the later zero-configuration entry above supersedes its enablement presentation while retaining host-permission, Unix-only, per-Agent assignment, and per-command approval disclosures.

### 2026-08-13

- Established the Skill Editor specification.
