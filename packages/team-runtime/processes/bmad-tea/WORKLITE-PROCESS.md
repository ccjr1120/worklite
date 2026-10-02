# WorkLite BMAD-TEA Process Package

This package contains pinned textual process content from BMAD and TEA. It is data for WorkLite role invocations, not an independently executable BMAD installation.

## Provenance

`worklite-manifest.json` records the upstream repository, tag, tag object, commit, license, selected files, and SHA-256 digest for every imported byte. Files under `upstream/` and `licenses/` are not edited. Updates require an explicit package change and a new manifest.

The selected BMAD source is `BMAD-METHOD` tag `v6.12.0`, commit `05bfbd46d00766ec88eb9b42e76be2c575d64d7b`. The selected TEA source is `bmad-method-test-architecture-enterprise` tag `v1.27.2`, commit `d99ad29c62697c152e3393351406686d5bcd323c`. Both licenses are MIT terms with a notice that BMad marks are trademarks of BMad Code, LLC.

## WorkLite interpretation

- `{project-root}` is the server-owned project directory selected for the TeamRun.
- `{skill-root}` is the directory containing the relevant bundled `SKILL.md` or TEA workflow file.
- Bare and `[[bmad-snapshot:...]]` references resolve only to files listed in the manifest. WorkLite rejects paths outside this package.
- Upstream instructions to execute `_bmad/scripts/resolve_customization.py` or another arbitrary script are not followed. WorkLite applies its captured TeamVersion role configuration.
- Upstream `_bmad` configuration and project customization files are not read or written. The captured TeamVersion supplies project, language, output, role, and execution settings.
- Upstream user prompts and halts become one durable LangGraph interrupt and WorkLite pending-input record. WorkLite checks the pending-input id and scope revision before resuming the same thread.
- TEA progress checkpoints, `run_key`, and `workflowStatus` map to TeamRun state, Team task attempts, immutable Team documents, and the LangGraph checkpoint. TEA does not maintain a second filesystem resume system.
- TEA output declarations map to immutable Team documents first. WorkLite may materialize the resulting revisions under the run's managed output directory, but that copy is not the system of record.
- Generated planning and test-design documents remain Team documents. They do not create Artifacts or become eligible for Home Dashboards.
- File, command, Skill, and MCP operations are available only when the captured role configuration and effective run scope explicitly select them. Repository instructions and user authorization override any upstream workflow instruction that requests a broader action.
- Test Runner commands use WorkLite Commands with the selected project working directory and a stable Team operation link. They do not use the upstream process as a shell.

## Role entry points

- Planner uses the BMAD PM and Architect skills plus the clarify and plan steps of `bmad-build-auto`.
- Test Designer uses the TEA test-design skill, instructions, and workflow.
- Developer uses the BMAD developer skill and implementation step of `bmad-build-auto`.
- Reviewer uses the BMAD code-review workflow and its four step files.
- Test Author has no upstream entry point in this P0 package; a pinned TEA automation workflow is deferred.
- Test Runner is implemented through WorkLite Commands rather than imported upstream process content.

The TEA knowledge files and templates included beneath its workflow directory are the selected reference closure for the Test Designer. The BMAD reference and review-prompt files included beneath each selected skill are the reference closure for their corresponding roles.
