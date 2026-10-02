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

Deployment replacement must pass a preflight gate: compile and start the new deployment on isolated resources, verify readiness, and only then stop or kill listeners on the target ports. If preflight fails, leave the existing target services untouched.

Do not automatically start, stop, restart, replace, or reconfigure running WorkLite server processes during implementation or verification. If a required service is unavailable or requires a restart, ask the user for explicit authorization for that lifecycle operation. Once the user explicitly authorizes it, you may perform the authorized operation, subject to the deployment preflight gate above.

By default, perform troubleshooting, investigation, and verification exclusively against the development profile: Web port `3390`, API port `3391`, Portkey Gateway port `3392`, and development data under `.data/` excluding `.data/deployment/`. When the user explicitly requests deployment-profile work, you may inspect and modify only the requested deployment resources, including Workflow synchronization, through the deployment profile's HTTP interfaces on ports `23390`–`23392`. When synchronizing Workflows to the deployment profile, inspect every model reference in the source graph against the deployment model catalog and replace local model ids with the correct deployment-supported equivalents before publishing; do not publish a graph that references an unavailable model. Access files under `.data/deployment/` only when the user explicitly requests direct deployment-data access. Keep the profiles separate, and never fall back from an unavailable development profile to the deployment profile without explicit authorization. Do not manage running WorkLite server processes without the user's explicit authorization.

## UI/UX Documentation

`ui-ux-design/README.md` is the source of truth for page structure, shared UI architecture, implementation sequencing, and page-level acceptance criteria. Store route specifications as `ui-ux-design/pages/<area>/<page>/DESIGN.md`, multi-page flows as `ui-ux-design/flows/<flow>/DESIGN.md`, and non-route surfaces as `ui-ux-design/surfaces/<domain>/<surface>/DESIGN.md`. Do not recreate a parallel page-specification directory.

Every `DESIGN.md` follows `ui-ux-design/TEMPLATE.md` in its section order and records a declared action budget, a per-state table, a copy inventory, and a dated Coverage Status listing the differences found against the implementation. Coverage Status is a verification result; do not restore a uniform unaudited placeholder.

`ui-ux-design/shared/interaction-contract.md` governs how many actions a task may cost: one activation point per goal, no preparation control paired with a commit control, no manual refresh for staleness the server can observe, control-local progress, and remembered input reapplied silently. `ui-ux-design/shared/copy-standards.md` governs which strings may exist: every string is an action, a state, a constraint, or a recovery, and text made obsolete by automation is deleted in the same change, in every locale.


## Durable Corrections

WorkLite has no first-use onboarding route family. Home derives first-use completion from persisted server resources, so a browser-state onboarding flow duplicates it with a weaker completion signal. Do not reintroduce `/onboarding` routes, an `onboardingStep` preference, or mock resource fixtures for a guided setup sequence.

State goals for generated writing, not layout. The user judges article output by whether it reads easily and says something clearly, and rejects fixed templates: banned-word lists, mandated section shapes, prescribed heading counts, and worked examples of allowed and forbidden forms all encode one person's taste as a rule and produce writing that reads as filled-in. Give the agent the reader outcome to aim at and let it choose the form. The exception is a constraint something downstream actually depends on, such as the single level-one heading and closed code fences the `worklite/artifact` publication gate rejects on, or the reference and link placement WeChat requires; keep those, state them as publication requirements, and keep them visibly separate from style so nobody has to guess which rules are load-bearing. When writing quality regresses, tighten the stated goal or the evidence behind it before adding another prohibition.

Retrieval and generation aids assist the agent; they do not overrule it. A check that can block work must earn that power, because a wrong block costs the run its evidence while a redundant call costs seconds. Prefer returning a judgement to the agent as advice alongside the result it questions, and reserve hard refusal for bounding a runaway loop. Limits that silently discard material an agent already retrieved, such as tool-result truncation, are the most expensive form of strictness and must be sized so that retrieved evidence survives to the writer.

The Memory One visual reference uses brand color sparingly. Keep WorkLite surfaces, default icons, headings, and ordinary hover states neutral; reserve the blue brand token for primary actions, selected or focused states, active execution, and a small number of meaningful links.

When the user corrects agent behavior or states a durable repository-specific working preference, update this `AGENTS.md` in the same change so future work follows that correction.

WorkLite’s primary product services are Workflow automation and Home. Home has no global Workflow data source. Workflow scheduling is represented by at most one versioned `worklite/timer` graph node with a minimum 300-second interval; publishing synchronizes the internal `workflow_schedules` runtime projection, which is not independently editable. Only a Workflow’s immutable Dashboard node makes its latest successful published-version Run output available to Home. Eligible boards default to Uncategorized and may be organized in at most one database-backed Home category; those organization references do not persist output or change eligibility. Source-specific features such as Meegle todos are workflow use cases, not standalone products or navigation destinations. Chat Bot is a protected shell and Home entry point, not a user-managed Agent resource. Workflow Agent nodes are the only user-configurable Agent capability and own their public model id, system prompt, explicit text or JSON output format, Skill selections, and MCP server selections inside the immutable WorkflowVersion while reusing shared Agent runtime infrastructure; JSON mode parses valid final responses and fails invalid JSON. Workflow edges support unconditional, structured predicate, and fallback routing plus optional positive `maxTraversals` bounds; every cycle must cross a bounded edge. Runs use a persisted deterministic sequential scheduler, and nodes with no unbounded incoming edges and no connected required inputs receive the initial invocation; an Agent whose only incoming context edge is bounded can therefore start from Workflow input. Successful execution of the explicit first-party `worklite/artifact` node is the only source of Workflow-created Artifacts; the node owns its Artifact name and text, markdown, or JSON type, persists the Artifact for a successful Run, and exposes an Artifact reference. Agent nodes do not create Artifacts. Plugins and Workflows are peer-level capabilities; Skills and MCP servers serve Workflow Agent nodes and Chat Bot.

Workflow deletion is permanent and removes its draft, edit revisions, published versions, schedule, and run history. Related Artifacts remain available with detached Workflow and Run references.

A failed Workflow Run is retryable at exactly one node: the persisted active invocation, exposed as the `retryable` Node Run flag and `POST /runs/:runId/nodes/:nodeRunId/retry`. Retry re-enters that same Node Run through the existing scheduler-resume path, so successful predecessors are never rerun. Retrying an earlier successful node stays deferred because it would require rolling back committed tokens, edge traversal counts, and downstream Artifacts. This manual command is independent of the per-node `retry` error policy that governs automatic in-run attempts.

WeChat Official Account automation must operate the real WeChat MP pages through Playwright. Do not substitute direct WeChat APIs or captured-session shortcuts for login, draft creation, publishing, or confirmation. Use a headless browser by default; switch to a headed browser only when explicitly requested or needed to debug a confirmed issue.

Classify a WeChat platform response as success or failure before extracting any text from it. `ret: 0`, `errcode: 0`, and `err_msg: "ok"` are success, so treating a present message or code as evidence of failure reports successful operations as rejections. Only after a response is classified as a failure may its `err_msg`, `errmsg`, or status code become user-facing error text.

A missing platform identifier is not the same condition as a platform rejection, and the two must produce different messages. WeChat confirms a saved draft through the editor URL gaining an `appmsgid` query parameter, not only through the save response body, so read the identifier from both and treat the URL as authoritative when the accepted response omits it.

A WeChat draft-mode failure must report the platform's own reason when the browser session exposes one: the failed draft-save response status text, or the text of a blocking editor dialog other than the known content-structure warning. A bare missing-draft-identifier message is the last resort, not the default, because remote runs are otherwise undiagnosable. A publication record that already holds a draft id reopens that draft even while its status is `failed`, so a node retry cannot leave a second draft in the official account.

The WeChat article editor is ProseMirror. It reparses pasted markup against its own schema and discards inline styles, so article HTML is inserted through the editor's own `window.__MP_Editor_JSAPI__` call `mp_editor_set_content` after `mp_editor_get_isready` reports a ready and new editor, with the clipboard paste kept only as a fallback. That content call requires a new editor, so the compose entry point opens the editor with `isNew=1`; a publication that already holds a draft id never refills its body. Calling the editor page's own JSAPI is operating the real MP page and is not a substituted WeChat backend API.

Retained block structure is not evidence of retained styling. A style-stripped article still yields multiple block elements, so a block-count check alone reports an unstyled article as a successful publish. Any pre-save verification must also assert that inline styles survived.

Headless QR login against the real WeChat MP site is verified working, including the `cgi-bin/home?token=` transition. Do not attribute a login failure to headless mode or add user-agent, locale, or other fingerprint overrides without first reproducing the failure and ruling out automation-side causes. WeChat sets the `slave_sid` and `slave_user` cookies about one second before the token page appears, so login confirmation must require the token page; cookie presence alone captures a storage state that has no editor token.


Gateway transport observability is its own `/logs` destination, not part of Providers and not a Settings page. Providers configures what the Gateway dispatches to; Logs reads what it did. Both of its read routes take an explicit absolute `from` and `to` range rather than a named relative window, because a name cannot express an arbitrary interval and a server-resolved name makes a shared link mean a different period for each reader. Statistics are retained indefinitely while request-log details expire after three days, so one shared range legitimately returns different coverage from the two stores; serve the request-log range as its intersection with the retention window and state the truncation rather than failing. Settings keeps Usage and Audit Log, which are WorkLite business records over Runs and resource mutations, not Gateway transport records.

Whenever WorkLite product architecture, resource relationships, supported Workflow nodes, or platform operations change, update the built-in Chat Bot prompt and `worklite-platform` Skill knowledge, contracts, scripts, and platform snapshot capability metadata in the same change.

Agent Team is a public API capability for one built-in Team. Team creation, Team deletion, and a dedicated Agent Team Web UI are not part of this boundary. Starting a Run captures an immutable TeamVersion, Commands require exact-string authorization, and Skills or MCP servers cannot be deleted while referenced by active Team configuration or a captured TeamVersion.
Chat Bot remains protected and is not user-deletable. Workflow Agent configuration is deleted with its owning Workflow version; there is no standalone Agent deletion flow. Skills and MCP servers cannot be deleted while referenced by an Agent, Workflow, or Agent Team. Artifacts are independently permanently deletable. Runs, immutable versions, logs, and built-in resources are not independently deletable.

The Portkey Gateway integration is a unified OpenAI-compatible entry point. Callers do not provide a Provider id separately; public model ids use the `<providerName>/<modelId>` namespace and the Gateway dispatches by the unique Provider name. Provider ids remain internal record keys and must not appear in public model ids. The local Gateway has no separate inbound API key unless a later architecture change explicitly adds one.

Provider protocol settings are authoritative. GLM intentionally uses the Responses API path. Do not switch a working Provider between Chat Completions and Responses merely for client compatibility.

The Portkey Gateway owns Provider persistence in an independent SQLite database and its dedicated `gateway_providers` table. The API SQLite database and legacy Provider JSON file are migration sources only; they are not Gateway runtime or administration stores.

Codex OAuth credentials are intentionally stored in the local Gateway SQLite database without an additional encryption-key configuration. This is a single-user local installation; users should re-authenticate after changing from an earlier encrypted Codex credential format.

Development and deployment profiles must use separate port ranges and data directories. Gateway startup must not import, synchronize, or alias Provider data from another profile; data transfer is explicit and owned by an operator-run script.

The development profile uses Web port `3390`, API port `3391`, and Portkey Gateway port `3392`. The local deployment profile remains on Web port `23390`, API port `23391`, and Portkey Gateway port `23392`. Do not add listeners, redirects, or fallbacks for previous development ports.

## Git Branch and Worktree Rule

Make authorized project changes directly on the `main` branch in the primary checkout. Do not create feature branches or additional worktrees unless the user explicitly requests them. Preserve existing local changes: inspect the working tree first, and do not commit or discard unrelated work. When the user requests a separate worktree, place it in the parent directory of the primary checkout and name it `../<repository-name>-<purpose>`, such as `../work-lite-workflow-optimization`.

## GitHub Research Rule

Use the authenticated `gh` CLI for GitHub repository searches, metadata inspection, and source browsing instead of direct web requests or browser search.

When implementing behavior that mirrors an existing open-source product or protocol, research and cite the relevant open-source implementation before proposing or coding the solution. Do not substitute assumptions or general experience for repository-backed behavior.

## Chat Configuration UI

The embedded Agent configuration view should follow the earlier Memory One chat-panel pattern: lightweight top tabs, unframed configuration content, and stable panel height across tabs. Top tabs remain the primary way to reach Configuration; slash commands do not replace them.

Chat Bot's product name is `Chat Bot`. `System Helper` is the former name and must not be reintroduced in identifiers, copy, documentation, or directory names. The persisted row id `agt_system_helper_chat` and Skill id `sk_worklite_platform` are data rather than naming, and are left unchanged because renaming them requires a migration that would orphan existing executions and Skill assignments.
