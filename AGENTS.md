# Project Language Policy

All files in this project must be written entirely in English.

This requirement applies to all project content, including:

- Source code identifiers, comments, and user-facing text
- Documentation and examples
- Configuration files and metadata
- Tests, fixtures, snapshots, and mock data
- Commit-related templates and automation messages stored in the repository

Do not add non-English text unless it is required as test data for functionality that explicitly handles other languages. In that case, keep the exception minimal and document its purpose in English.

When editing an existing file, preserve or improve compliance with this policy in the affected area.

## Required AI Workflow

Before starting any task, read `AGENTS_WORKFLOW.md` and follow the applicable workflow defined there. Do not begin work directly without using that workflow.

## Compatibility Policy

When changing routes, APIs, configuration, or other public project behavior, the default implementation does not preserve legacy compatibility. Do not add redirects, aliases, adapters, migrations, or other compatibility layers unless the user explicitly requests them. When compatibility is intentionally omitted, call out the resulting impact in the handoff.
