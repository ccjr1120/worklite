# Skill Editor

## Route

`/skills/{new,:skillId}`

## Design Source

- `docs/ui-design-system/README.md`
- Applicable shared specifications in `ui-ux-design/shared/`

## Implementation

- `apps/web/src/routes/skills/$skillId.tsx`

## Purpose

Author a Skill package — its instructions, scripts, and references — and run its scripts directly.

## Primary Task

Persist the package. Action budget: one — `Save`. The name and every file edit the same draft, and `Save` commits them together. Adding or deleting a package file is a local draft edit, not a separate commit.

Running a script is a separate goal with its own budget of one — `Run`. Execution is a genuinely independent intent: it starts a process on the host using the persisted package, changes nothing about what is stored, and is available on read-only built-in packages that have no `Save` at all. It is therefore not folded into the commit. `Run` is disabled while an editable Skill has unsaved changes, because it executes persisted content rather than the draft in the editor.

## Layout

Every Skill detail uses the same editor workspace: a compact package tree on the left and the selected file viewer or editor in the remaining space. The tree renders only files returned by the API, derives folder nodes from their paths, and never hard-codes example entries. Empty directories are not shown. Use the shared monospace editor for current text files; introduce CodeMirror 6 only when a concrete editing requirement needs structured editing behavior.

The context bar holds the breadcrumb, the save indicator for editable packages or a read-only marker for built-ins, the destructive delete icon for saved non-built-in Skills, and `Save`. The selected-file header holds the file path, its executable or missing-shebang marker, `Run` for scripts, and the delete-file action for non-root files. Script files additionally show a host-permission warning band with the arguments field. The execution output region occupies a fixed-height panel below the editor.

Online user Skills support a required root `SKILL.md`, executable text files under `scripts/`, and text files under `references/`. New Skills begin with `SKILL.md`. A compact add-file icon exposes an inline relative-path field; deleting a selected non-root file requires an explicit action, while `SKILL.md` cannot be deleted. File paths and content use the typed package API and retain visible unsaved, saving, saved, path-validation, and durable error states. Folder-imported Skills use the same editable package surface and retain their archive source label. Binary assets, validation, and publication remain absent.

Protected built-ins use the same package tree and file surface, with read-only content and no save, validate, publish, upload, or delete actions. Read-only executable files retain the same `Run`, argument, output, and cancellation controls as user Skill scripts. Built-in and assignment metadata appears compactly beside the tree or file header instead of replacing the package layout with a centered marketing or settings page.

For `terminal-command`, show its product-owned `scripts/run.sh`, built-in status, explicit Workflow Agent node selection, automatic Workflow execution, API process working directory, `/bin/sh -lc`, and the non-sandbox host-permission warning. Do not present it as a special runtime capability. For `worklite-platform`, show its product-owned scripts and contract reference, built-in status, protected Chat Bot ownership, loopback API boundary, automatic script execution, secure credential rules, constrained client navigation, and the exclusion of external APIs, direct database access, deletion, terminal execution, editing, publication, and manual assignment.

## Interaction Contract

`Save` reports progress on itself, commits the name and every package file, and settles the save indicator at `Saved`. A new Skill navigates to its own route on first save without losing draft state. Failure returns the indicator to `Unsaved changes` and states the reason durably at the foot of the editor; a missing name reports on the name field itself.

Adding a file validates its relative path locally and reports an invalid or duplicate path next to the path field without committing anything. A new script is seeded with a shebang so it is executable by default. Both adding and deleting a file mark the draft unsaved.

`Run` validates the arguments field as a JSON string array before starting, reporting a malformed value next to that field. Saved script files with a Unix shebang expose `Run` in the selected-file header, including scripts in read-only built-in packages. A single-line JSON string-array field supplies exact arguments without shell parsing ambiguity. Direct execution uses the persisted package, so `Run` is disabled while an editable Skill has unsaved changes, while saving, or when the selected script lacks a shebang. Activating `Run` starts the script immediately on the server without Agent assignment, a Model Provider, model selection, or a second approval step.

After a direct run starts, show an unframed output region below the editor with a non-color status badge, ordered stdout, stderr, and lifecycle labels, exit code or signal, reconnect state, and `Cancel` while active. Long uncapped output scrolls within the region and follows new events only while the user remains at the end. Browser navigation or event-stream disconnection does not stop the process.

Output arrives on the command event stream. A dropped stream reconnects on its own and states that it is reconnecting without stopping the script, per `shared/interaction-contract.md`; there is no manual refresh control for the output region. `Cancel` is a neutral execution control rather than a destructive one and reports on its own control.

The editor clearly discloses that execution uses the API process's host permissions, current working directory, and complete environment. It does not expose interpreter, working-directory, environment, sandbox, timeout, output-limit, or host-access configuration fields.

Delete keeps its own confirmation, per the permanent-removal exception in `shared/interaction-contract.md`. Dependency conflicts remain visible in the named confirmation dialog; successful deletion returns to the Skill list.

## States

| State | Behavior |
| --- | --- |
| Loading | Existing Skills show the editor shell with a skeleton package tree and a skeleton file region inside a `role="status"` live region. Replacing the whole workspace with a centered line discards the shell and is not sufficient. |
| Empty | A started execution with no events yet states that output appears once the script starts. A new Skill opens with `SKILL.md` selected rather than an empty tree. |
| No results | Not applicable; this surface has no filtering. |
| Error | A failed Skill load keeps the editor shell and offers a retry. Save failure stays durably at the foot of the editor; path and argument validation stay on their fields; execution failure stays with the output region. |
| Busy | `Save`, `Run`, and `Cancel` each report on themselves. A running script keeps the editor and the package tree usable. |
| Offline | Inherits `shared-states.md`. The output stream resumes without restarting the script or duplicating events. |
| Long content | Output is uncapped and scrolls within its fixed-height region, following the end only while the reader is already there. Long file paths truncate in the tree with their complete value reachable. |

## Copy Inventory

| Key | Category |
| --- | --- |
| `skills:editor.new` | State |
| `skills:editor.fallback` | State |
| `skills:editor.name` | State |
| `skills:editor.create` | Action |
| `skills:editor.package` | State |
| `skills:editor.addFile` | Action |
| `skills:editor.deleteFile` | Action |
| `skills:editor.filePath` | State |
| `skills:editor.filePathHint` | Constraint |
| `skills:editor.pathInvalid` | Recovery |
| `skills:editor.pathDuplicate` | Recovery |
| `skills:editor.executable` | State |
| `skills:editor.missingShebang` | State |
| `skills:editor.scriptWarning` | Constraint |
| `skills:editor.run.action` | Action |
| `skills:editor.run.arguments` | State |
| `skills:editor.run.argumentsHint` | Constraint |
| `skills:editor.run.invalidArguments` | Recovery |
| `skills:editor.run.saveFirst` | Recovery |
| `skills:editor.run.output` | State |
| `skills:editor.run.emptyOutput` | State |
| `skills:editor.run.stdout` | State |
| `skills:editor.run.stderr` | State |
| `skills:editor.run.lifecycle` | State |
| `skills:editor.run.exitCode` | State |
| `skills:editor.run.signal` | State |
| `skills:editor.run.cancel` | Action |
| `skills:editor.run.reconnecting` | State |
| `skills:editor.run.startFailed` | Recovery |
| `skills:editor.run.loadFailed` | Recovery |
| `skills:editor.run.cancelFailed` | Recovery |
| `skills:editor.readOnly` | State |
| `skills:editor.builtInReadOnly` | State |
| `skills:editor.nameRequired` | Recovery |
| `skills:editor.saveFailed` | Recovery |
| `skills:editor.loading` | State |
| `skills:editor.loadFailed` | Recovery |
| `skills:terminal.warning` | Constraint |
| `skills:platform.boundary` | Constraint |
| `skills:source.built-in` | State |
| `skills:delete.*` | Constraint, Action |
| `common:actions.save` | Action |
| `common:actions.cancel` | Action |
| `common:saveState.*` | State |

`skills:platform.systemOnly` is removed: it is defined but referenced by neither this editor nor the Skill list.

`skills:editor.scriptWarning`, `skills:terminal.warning`, and `skills:platform.boundary` are retained as Constraints. Each states a host-permission or capability boundary the reader cannot infer and must know before running a script.

`skills:editor.run.saveFirst` is retained as Recovery: it names why `Run` is unavailable and what to do about it.

## Accessibility

`Tab` reaches the name field, the add-file control, each package-tree entry, the selected-file header controls, the arguments field, the file editor, then the output region's `Cancel`. Each tree entry is a `button` with `aria-pressed` reflecting selection, so the current file is not conveyed by background color alone. The file editor carries its path as its accessible name. The name, path, and arguments fields associate their validation messages with the input through `aria-invalid` and `role="alert"`.

Executable and missing-shebang markers are text badges. Execution status uses the shared status badge with a text label, and exit code or signal is stated as text. The reconnecting notice is text with an icon. The read-only marker is text with an icon rather than a disabled appearance alone. Icon-only controls for add file, delete file, delete Skill, and cancel-add have accessible names and tooltips. Reduced-motion mode keeps static cues for the saving, launching, and reconnecting spinners. The output region is keyboard scrollable and does not steal focus when new events arrive.

## Coverage Status

Verified 2026-09-19. Differences found against `apps/web/src/routes/skills/$skillId.tsx`:

- No loading skeleton. `ResourceState` replaces the entire editor workspace with one centered line, discarding the shell that `shared-states.md` requires to stay stable.
- The load-error branch offers no retry, only a static message, so a transient failure has no in-page recovery.
- The execution `useEffect` depends on the whole `execution` object and calls `setExecution` inside `refreshExecution`, so each lifecycle event tears down and re-opens the `EventSource`. Reconnection works, but the stream is re-established more often than the specification intends.
- `editor.run.saveFirst` is rendered both as the `Run` button's `title` and as a separate warning line in the script band, so the same recovery text appears twice.
- The delete-file action has no confirmation and no undo, and it is a local draft edit, which matches this specification but is not stated anywhere in the UI.
- `skills:platform.systemOnly` is defined but never referenced.
- The arguments field and the host-permission warning render for any file under `scripts/`, including one without a shebang that cannot be run, so the warning appears where no execution is possible.

## Changelog

### 2026-09-19

- Rewrote this specification against `TEMPLATE.md`, adding per-goal action budgets, the per-state table, the copy inventory, and verified coverage findings.
- Documented `Run` as a legitimately separate action from `Save`, with the reason: it executes persisted content on the host, changes nothing stored, and exists on read-only built-in packages that have no `Save`.
- Required the editor shell to stay stable during loading and failure, with a retry on load failure.
- Required the output stream to reconnect on its own with no manual refresh control, and removed the duplicated `run.saveFirst` presentation.
- Removed the unreferenced `platform.systemOnly` key under the new copy standards.

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

- Initially added an opt-in read-only terminal Skill state; the later zero-configuration entry above supersedes its enablement presentation while retaining host-permission, Unix-only, Workflow Agent node selection, and per-command approval disclosures.

### 2026-08-13

- Established the Skill Editor specification.
