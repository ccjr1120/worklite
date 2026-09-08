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

Do not run tests, test scripts, diagnostic scripts, builds, development or start servers, browser checks, `curl` requests, `pnpm typecheck`, or other verification commands unless the user explicitly instructs you to run that specific command or check in the current request. Do not perform verification proactively.

## Durable Corrections

The Memory One visual reference uses brand color sparingly. Keep WorkLite surfaces, default icons, headings, and ordinary hover states neutral; reserve the blue brand token for primary actions, selected or focused states, active execution, and a small number of meaningful links.

When the user corrects agent behavior or states a durable repository-specific working preference, update this `AGENTS.md` in the same change so future work follows that correction.

The Portkey Gateway integration is a unified OpenAI-compatible entry point. Callers do not provide a Provider id separately; public model ids use the `<providerName>/<modelId>` namespace and the Gateway dispatches by the unique Provider name. Provider ids remain internal record keys and must not appear in public model ids. The local Gateway has no separate inbound API key unless a later architecture change explicitly adds one.

The Portkey Gateway owns Provider persistence in an independent SQLite database and its dedicated `gateway_providers` table. The API SQLite database and legacy Provider JSON file are migration sources only; they are not Gateway runtime or administration stores.

Codex OAuth credentials are intentionally stored in the local Gateway SQLite database without an additional encryption-key configuration. This is a single-user local installation; users should re-authenticate after changing from an earlier encrypted Codex credential format.

Development and deployment profiles must use separate port ranges and data directories. Gateway startup must not import, synchronize, or alias Provider data from another profile; data transfer is explicit and owned by an operator-run script.

## Git Worktree Directory Rule

Place additional worktrees in the parent directory of the primary checkout. Name each worktree as `../<repository-name>-<purpose>`, such as `../work-lite-workflow-optimization`.

## GitHub Research Rule

Use the authenticated `gh` CLI for GitHub repository searches, metadata inspection, and source browsing instead of direct web requests or browser search.

When implementing behavior that mirrors an existing open-source product or protocol, research and cite the relevant open-source implementation before proposing or coding the solution. Do not substitute assumptions or general experience for repository-backed behavior.

## Chat Configuration UI

The embedded Agent configuration view should follow the earlier Memory One chat-panel pattern: lightweight top tabs, unframed configuration content, and stable panel height across tabs.
