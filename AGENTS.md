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

## Minimal Implementation Policy

Implement only the smallest direct change required by the confirmed request. Do not proactively add validation, limits, compatibility layers, abstractions, fallback behavior, security hardening, or adjacent UX changes unless they are explicitly requested or required by an existing project rule.

When an out-of-scope concern is discovered, mention it briefly instead of expanding the implementation.

## Development Verification

Unless the user explicitly authorizes it in the current request, do not run tests, builds, development or start servers, browser checks, `curl` requests, or other behavioral verification. Limit verification to the simple TypeScript check: `pnpm typecheck`.

## Durable Corrections

When the user corrects agent behavior or states a durable repository-specific working preference, update this `AGENTS.md` in the same change so future work follows that correction.

## Git Worktree Directory Rule

Place additional worktrees in the parent directory of the primary checkout. Name each worktree as `../<repository-name>-<purpose>`, such as `../work-lite-workflow-optimization`.
