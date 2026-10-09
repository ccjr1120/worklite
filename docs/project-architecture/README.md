# Project Architecture

## Status and Governance

This document is the source of truth for the WorkLite architecture. Architecture changes must follow the `Project Architecture Change Workflow` in `AGENTS_WORKFLOW.md`: discuss the change with the user, obtain explicit confirmation, update this document and its changelog, and only then implement the approved design.

This is the approved initial baseline. Target-state components may be introduced incrementally.

## Product Overview

WorkLite is a single-user personal tool for creating and running workflows. One local workspace manages model providers, skills, MCP servers, workflows, runs, and artifacts. Chat is the dedicated Agent workspace and the protected product-owned master conversation capability.

The user-facing AI execution model is Workflow-first. Published Workflows are available through the Chat `@` dispatcher: the dispatcher resolves a published Workflow by name, passes the remaining message text as the `worklite/input` value, creates a normal version-bound Workflow Run, and presents its status and Artifacts in the same transcript. Draft Workflows are not runnable from chat. Workflows do not reference Agent or AgentVersion resources. Instead, each Workflow Agent node owns its public model id, system prompt, Skill selections, and MCP server selections inside the versioned workflow definition. A workflow can be edited with explicit add-node controls or through a natural-language AI assistant. Every AI change is recorded and reversible, similar to an AI-assisted code editor.

Chat can inspect the workspace and create Provider, Skill, MCP server, and Workflow drafts through assigned Skill scripts. Every script request is explicit, executes automatically after server validation, and remains subject to the same validation, secret-handling, publication, and audit rules as manual configuration.

Agent Team is an in-progress software-development capability. Its confirmed implementation direction combines BMAD and TEA process content with a LangGraph.js execution runtime. The implementation plan is recorded in [Agent Team Implementation Plan](agent-team-implementation.md). The public REST and replayable Server-Sent Event boundary is available; the first release has one built-in Team and no Team creation or deletion API. The Team detail route is a Team-owned Coordinator conversation, while the direct Team Run route remains immutable execution evidence.

## Architectural Principles

1. Use a browser/server architecture with a separately deployable web application and API; durable worker execution is a later scale-out boundary.
2. Keep applications and shared packages in a TypeScript monorepo.
3. Use one installation-owned workspace as the resource-isolation boundary.
4. Keep published versions immutable and bind runs to explicit versions.
5. Model workflows as versioned directed control-flow dataflow graphs with explicit nodes, ports, conditional edges, bounded loop edges, and persisted canvas layout.
6. Execute workflow runs asynchronously without blocking HTTP requests; the initial local runtime may execute them inside the API process.
7. Treat uploaded skills and MCP responses as untrusted.
8. Keep domain logic independent from controllers and queue processors.
9. Update this document before implementing an approved architecture change.

## System Architecture

```text
Browser
  |
  v
Static Web Hosting / Reverse Proxy
  |-- React SPA
  `-- /api --> NestJS API
                  |-- SQLite
                  |-- Portkey Gateway sidecar
                  |-- Host command executor
                  |-- In-process run executor
                  |     |-- Model providers
                  |     |-- MCP servers
                  |     `-- Skill and Agent execution
                  `-- SQLite textual artifacts and skill content

Browser <---- Server-Sent Events ---- API
```

The web application is delivered as static assets and is only an HTTP and Server-Sent Events client. The API owns domain operations, command execution, workflow revisions, run creation, and progress delivery. The local installation is intentionally single-user and has no account or authorization boundary. Command and workflow execution continue independently of browser connections.

## Technology Baseline

### Monorepo

- pnpm workspaces for dependency and workspace management.
- Turborepo for task orchestration and caching.
- TypeScript across the web, API, and shared packages.

### Web Application

- React with Vite.
- TanStack Router with file-based, type-safe routing.
- TanStack Query for server state and caching.
- Zustand for transient editor state and local undo/redo.
- Tailwind CSS and shadcn/ui for the UI system.
- `@xyflow/react` for the workflow graph canvas and React-rendered node components.
- Existing typed form controls for current forms. A dedicated editor dependency is added only when a concrete editing surface requires it; CodeMirror 6 is the preferred lightweight option for future Markdown, JSON, or shell editing.
- Server-Sent Events for workflow-run progress.
- i18next with react-i18next for application internationalization.

TanStack Router owns URL and navigation state. TanStack Query owns remote server state. Zustand owns uncommitted editor state. Backend authorization remains authoritative.

The personal installation has no public sign-in, account creation, email verification, invitation, or password recovery flow. The root route opens Home directly and the API accepts requests without a session cookie. This is intentional for local use. Because the API includes unrestricted host command execution, it binds to `127.0.0.1` by default; listening on another interface requires an explicit `API_HOST` value and transfers responsibility for network access control to the operator.

Local development serves only the Vite web application on port `3390`; it does not start a development API or Gateway. The Vite proxy forwards same-origin `/api` requests to the managed deployment API on loopback port `23391`, so development reads and writes the deployment-owned state under `.data/deployment/` and has no separate development database. The local deployment exposes only the built Web application on port `23390`; its same-origin `/api` requests are proxied internally to the same loopback API. Portkey Gateway uses loopback port `23392` in deployment; none of these backend ports are external endpoints. Gateway lifecycle is owned by the deployment API and automatic: the sidecar starts with the API, is restarted after an unexpected exit, and has no user-facing start, stop, or restart controls. Codex transport runs inside the Gateway process and has no separate listener.

Each operator invocation of `pnpm deploy:local` increments the patch component of the public product version in `apps/web/package.json` through `scripts/bump-deployment-version.mjs`, before dependency installation and candidate compilation. The existing Web version label uses that captured version. Failed attempts consume the source version while the active deployment retains its previously built version. No Git branch, commit, tag or workspace-package synchronization is part of this deployment counter. Immutable managed releases keep their manifest-bound version; they do not mutate it during runner execution.

`pnpm deploy:local` then invokes `scripts/upgrade-runner.mjs deploy deployment`. When `.data/deployment/runtime/current.json` is absent, the runner captures the current project, builds it, copies deployment data for isolated preflight on ports `23490`–`23492`, and verifies readiness before touching the deployment listeners. Gateway releases materialize the ignored local `conf.json` from tracked `conf.example.json` when absent, so local configuration and credentials are not copied into the immutable release. If the legacy `install-local.sh` deployment owns the target listeners, the runner may stop only the process group recorded in `.data/deployment/worklite-local.pid` after confirming it is this project's `start-local.mjs`; an unowned or mismatched listener makes the operation fail without stopping it. The runner backs up deployment data and starts the managed baseline on `23390`–`23392`. If that first managed startup fails, matching data is restored, while the stopped legacy service is not restarted; the operator can run `pnpm deploy:local` again. Once a baseline exists, operator and Chat-authorized deployments use the same independent runner: compile and readiness-check the candidate on isolated ports first, then cancel active Agent, Team, Workflow, and Command work and replace the managed process group without waiting for executions to finish. Interrupted work is not automatically resumed after success or rollback. If candidate startup fails, the runner restores the matching previous program and data. Unknown listeners remain untouched. This command is the supported operator path for both the first managed deployment and subsequent releases. Chat redeployment continues to require the managed baseline and a current user request.

Authenticated workspace routes do not include a locale segment. The Web application uses one fixed Chinese resource set (`zh-CN`) and does not expose, persist, or synchronize a locale preference. API contracts, persisted domain values, identifiers, logs, and externally supplied content remain language-neutral.

### API and Execution

- NestJS for the HTTP API.
- REST for configuration and command APIs.
- Server-Sent Events for one-way progress delivery.
- An in-process asynchronous executor for the initial local runtime. A durable queue is a later production scale-out boundary.
- Portkey Gateway as a local sidecar for Workflow and conversational LLM communication. Codex and Claude Code project executors also send their model traffic through it. The `portkey-gateway` module owns automatic startup, readiness, and crash recovery; the sidecar listens on a loopback port configured by `PORTKEY_GATEWAY_PORT` and exposes no lifecycle mutation API. The gateway source is maintained as a pinned local workspace package so WorkLite can patch provider routing, provider administration, model discovery behavior, and the Codex Responses transport.
- A Gateway-native `codex/responses` Provider adapter for direct Codex Responses API transport. It runs in the Gateway process, uses the local Gateway SQLite credential record with an optional environment-token fallback, and is selected through the normal Provider registry rather than a separate HTTP sidecar.

### Host Command Interface

Host command execution is a server-owned capability independent from the web application, Model Providers, Agents, Skills, and approval state. The public interface is:

```text
POST /commands
GET  /commands
GET  /commands/:commandId
GET  /commands/:commandId/events
POST /commands/:commandId/cancel
```

Creating a command persists it and starts it asynchronously through `/bin/sh -lc`. The child process uses `process.cwd()`, inherits the API process's complete `process.env`, and runs with the same operating-system permissions as the API process. WorkLite does not add a sandbox, directory isolation, environment filtering, forced timeout, or output-size cap. The API binds to `127.0.0.1` by default because any caller with API access can execute commands with those permissions; `API_HOST` explicitly opts into another interface.

Each execution persists its command, working directory, lifecycle status, process identifier, exit code or terminating signal, timestamps, and ordered stdout, stderr, and lifecycle events. Server-Sent Events provide live observation and replay persisted events when a client connects or reconnects. Browser or SSE disconnection never cancels execution. Cancellation terminates the command's process group and records the resulting lifecycle state.

The Commands module owns all process spawning. It is an API runtime primitive rather than a separate terminal product surface. WorkLite has no `/terminal` route, generic command composer, or terminal navigation item. The Skill editor is the direct web entry point for user-authored scripts, while Agent terminal tools and executable Skill integrations delegate process execution to Commands instead of owning separate child-process policies.

### Model Gateway

- WorkLite owns a provider-neutral `model-gateway` package between agent execution and the default protected `gateway-provider` binding.
- AI SDK is the initial provider integration layer. The gateway may use `@ai-sdk/anthropic`, `@ai-sdk/openai`, and other provider packages without exposing AI SDK types in domain contracts or persistence models.
- The gateway resolves Provider configuration and secrets from its own persistent registry, creates model handles, streams normalized model output, and reports provider-neutral usage and failures to the agent runtime.
- AI SDK owns the generic model-tool loop for Workflow Agent nodes through `ToolLoopAgent`, loop-stop conditions, and per-step tool activation. WorkLite continues to own Workflow business tools, Skill and MCP execution, budgets, cancellation, activity records, Workflow persistence, the deterministic Workflow scheduler, and provider transport. The gateway exposes this capability through a provider-neutral internal request/result contract and does not expose AI SDK types to Workflow or domain contracts.
- Multi-step Agent generation uses streaming as its primary transport. The gateway records upstream stream errors, surfaces the original failure when a stream emits no output, and retries only retryable failures before any output is emitted. If the AI SDK reports that no output was generated and the request was not aborted, the gateway makes one non-stream generation attempt so an upstream streaming-transport quirk does not mask a usable model response. Persisted failures expose a credential-safe provider status or empty-stream diagnosis rather than the AI SDK's generic no-output text.
- Agent Requests sent to a Provider whose runtime operation is OpenAI Responses declare function tools in non-strict mode and disable AI SDK strict JSON-schema response constraints for that request. This keeps providers that implement Responses but not every OpenAI strict-schema option usable for Skills and MCP tools; Chat Completions and Anthropic Messages requests retain their existing behavior.
- AI SDK does not own WorkLite tenancy, workflow persistence, queues, audit records, quotas, or sandbox policy. Provider credentials and Provider catalog persistence belong to Portkey Gateway; the WorkLite API only mediates the local administration surface.
- DeepSeek Harness is not a core runtime dependency. A future adapter may use it for DeepSeek-native Agent execution, but the initial Agent Runtime and Workflow Engine depend only on the WorkLite gateway contract.
- The Web application is Chinese-only. It keeps one fixed `zh-CN` resource set for consistent copy and formatting, removes the language-selection setting and English runtime resources, and does not persist or synchronize a locale preference.
- Gateway request observability is durable and Gateway-owned. Every Provider-bound `/v1` request is stored with its transformed request body, complete non-stream response or raw streaming SSE data, status, duration, usage when available, and opaque Workflow correlation metadata. Request headers, credentials, and custom header values are excluded. Provider attribution uses the internal `x-worklite-stat-provider` header supplied by WorkLite model execution when a model namespace alone cannot identify the Provider; explicit attribution takes precedence over model-prefix inference, and internal `x-worklite-*` metadata is not forwarded upstream. Request-log rows are automatically deleted after three days; the retention period is fixed by this increment and is not a user setting. Aggregate statistics are retained indefinitely.
- Gateway observability is read through its own Logs destination, and both of its read routes are queried by an explicit absolute time range rather than a named relative window.

### Provider Proxy

WorkLite exposes one unified Gateway proxy entry point for the workspace, with OpenAI-compatible and Claude Messages routes. Workflow and conversational model communication, Provider tests, model discovery, and public proxy requests pass through the local Portkey Gateway sidecar. Codex project execution reaches it through the `~/.codex-cli` Responses Provider, and Claude Code through the `/v1/messages` route named by its effective `ANTHROPIC_BASE_URL`. The public proxy routes are:

```text
/api/portkey-gateway/v1/models
/api/portkey-gateway/v1/chat/completions
/api/portkey-gateway/v1/responses
/api/portkey-gateway/v1/messages
/api/portkey-gateway/v1/images/generations
/api/portkey-gateway/v1/systemone
/api/portkey-gateway/providers
/api/portkey-gateway/providers/:providerId
/api/portkey-gateway/providers/:providerId/test
/api/portkey-gateway/model-providers/discover-models
/api/portkey-gateway/codex/accounts/usage
```

Portkey Gateway is the sole owner of Provider records, encrypted API keys, base URLs, protocol selections, model catalogs, and headers. The unified `models` response prefixes every configured model with its unique Provider name as `<providerName>/<modelId>`. Provider ids remain internal record keys for persisted Agent bindings and administration routes; they are not part of the public OpenAI-compatible model namespace. Gateway administration routes persist Provider records and return their metadata together with the stored API key; the WorkLite API proxies those routes without decrypting or storing upstream secrets. For every LLM request the Gateway resolves the Provider name from the requested namespaced model, validates the model against that Provider's catalog, and applies the stored upstream credentials and headers. Provider names are unique. Renaming a Provider changes its public model namespace immediately, and the previous name is not retained as a compatibility alias. Provider configuration has no separate vendor type: a user-supplied `baseURL` and namespaced `protocol` such as `openai/chat`, `openai/responses`, `anthropic/messages`, `codex/responses`, or `typesafe/systemone` identify the upstream wire contract. `anthropic/messages` uses the Claude Messages transport. `codex/responses` remains the Codex Provider protocol, but its Gateway-owned adapter supports the Codex Responses transport and a dedicated Codex Images generation transport. The Codex adapter uses the Gateway-owned local credential record for its private upstream access token; its Provider `baseURL` is metadata and does not control private Codex routing. The model-discovery route accepts an unsaved Provider draft and returns a de-duplicated model ID list without persisting the draft.

Provider administration is a Gateway-owned view exposed through the top-level `Providers` menu. WorkLite retains one protected `gateway-provider` binding for Agent and Workflow runtime resolution; that record is an internal implementation detail and is never returned by Provider APIs or rendered in user configuration. The Providers page shows user-managed Gateway Providers and the unified Gateway endpoint. When the Gateway has at least one enabled Codex account with usable OAuth credentials, or `CODEX_ACCESS_TOKEN`, it automatically upserts one Gateway-owned Provider named `codex` with protocol `codex/responses`, no API key, and a model catalog synchronized from the Codex `/models` endpoint and augmented with the known `gpt-image-2` image model. The Gateway owns a Codex account pool in its SQLite database. Operators can add accounts through OAuth login or import the supported account-export JSON document; imported accounts are upserted by ChatGPT account id without returning tokens to the browser. Each account stores its enabled state, priority, concurrency, automatic-expiry pause preference, and rate multiplier metadata. Requests select an enabled usable account from the highest available priority using round-robin scheduling while respecting its configured concurrency. An unauthorized response refreshes only the selected account; a failed refresh or expired credential pauses that account when automatic expiry pause is enabled and allows another eligible account to serve a later request. Operators can explicitly enable or disable each account. The imported `proxies` collection is ignored, and rate multiplier is retained as metadata rather than used for weighted routing. This automatic Provider uses a stable internal id, is not created through the browser CRUD form, and is omitted from Provider responses while neither the account pool nor the environment credential is usable. A temporary Codex model-discovery failure does not remove the automatic Provider or erase its last known catalog. Removing or disabling every account and removing the environment credential hides the automatic Provider and leaves Agent bindings unresolved until Codex is configured again. No legacy single-account compatibility layer is retained; existing local credentials must be re-authenticated or imported after the schema change.

`typesafe/systemone` is a credential-forwarding transport rather than a text-generation protocol. Its upstream contract accepts a `state` value and a typed `questions` collection and returns a typed `answers` collection, so it has no messages, system prompt, tool declarations, or streaming form. The Gateway does not translate this protocol into or out of any chat contract. It resolves the Provider from the public `<providerName>/<modelId>` namespace, replaces the namespaced `model` field with the upstream model id, attaches the stored API key and headers, forwards the request body unchanged, and returns the upstream response unchanged. Because the request never enters a Portkey provider handler, this transport records its own request statistics and request log directly; the upstream `input_tokens` and `output_tokens` values populate the existing token statistics without a separate accounting path. Providers using this protocol are excluded from Agent model selection, since an Agent node's system prompt and output format have no meaning in this contract. Its connection test sends one minimal typed question instead of the fixed chat prompt, and its model catalog is entered manually because the upstream publishes no model-discovery endpoint.

Codex image generation is exposed through the unified Provider proxy route above and the first-party Workflow image node. The Codex adapter forwards an explicit generation allowlist consisting of `prompt`, `model`, `n`, `background`, `quality`, and `size`; standard OpenAI Images fields that Codex does not define, including `response_format`, `style`, and `user`, are not forwarded. The Provider protocol remains `codex/responses`, and the automatic Provider advertises `gpt-image-2` as `codex/gpt-image-2`. Requests use the Codex OAuth account pool and the same selected-account one-shot unauthorized refresh behavior as Responses transport. Upstream JSON, including each generated image in `data[].b64_json`, is returned to the original caller, while account entitlement and image-generation quota failures surface as upstream errors. Image edits and binary Artifact persistence remain unsupported.

For each Codex account, the Gateway exposes a credential-safe account usage view through `GET /worklite/codex/accounts/usage`. Enabled accounts are queried independently from the ChatGPT `/wham/usage` endpoint with their current access token and account id; a token is refreshed once after an unauthorized response. Disabled accounts return their persisted account status without an upstream usage request. Each result preserves the provider-reported plan type, primary and secondary windows, used percentage, duration, reset time, and fetch time. A single account failure is returned on that account while other accounts continue to load, and a usage-query failure does not change Codex authentication state. The API proxies this per-account snapshot to the Providers page without persisting it or adding it to Gateway request statistics.

Portkey runs as a server-owned sidecar on a loopback-only internal port. The API owns automatic sidecar startup, readiness, crash recovery, shutdown, and failure reporting; it does not expose lifecycle mutation controls to clients. Client request bodies, status codes, streaming responses, and credential-safe upstream errors are proxied without creating a Run, Artifact, Agent execution, Audit Log, or Usage row. Agent Runtime requests use the hidden `gateway-provider` binding through the same sidecar; AI SDK remains a message and streaming normalization layer, not a direct upstream transport. LLM traffic is therefore centralized in the Gateway while proxy traffic remains transport-only and is not included in Agent or Workflow runtime accounting.

The proxy inherits the API's local security boundary: the API binds to `127.0.0.1` by default and has no separate inbound authentication scheme, so the Gateway integration page displays that no key is required. Setting `API_HOST` to another interface exposes both the WorkLite API and Provider proxy to that network and remains the operator's responsibility. Provider configuration changes take effect on the next request; Provider versions do not snapshot proxy traffic. No compatibility aliases for the standalone `local-llm-proxy` routes are provided.

Portkey Gateway records one credential-safe request statistic and one request-log detail for each Provider-bound `/v1` request in its own SQLite database. The permanent `gateway_request_stats` record contains the request timestamp, resolved Provider name, model id, endpoint, HTTP status, duration, and normalized input, output, and total token counts when available. The three-day `gateway_request_logs` record additionally contains the transformed upstream request body, complete response capture, parsed JSON when possible, raw text for non-JSON responses, parsed SSE data payloads for streaming responses, and optional `source`, `workflowRunId`, and `nodeRunId` correlation values. Prompts, responses, credentials, and custom header values are excluded from the statistics record and credential-sensitive routing metadata; correlation headers are not forwarded upstream.

Gateway statistics are read-only aggregations over the permanent `gateway_request_stats` table, while request-log details are read from `gateway_request_logs`. Both are queried by an explicit absolute time range over their `occurred_at` column. The two records share one normalized request outcome and token extraction step, but have different retention policies: statistics are retained indefinitely and request-log details are automatically deleted after three days. Provider usage is normalized from `prompt_tokens`/`input_tokens`, `completion_tokens`/`output_tokens`, and `total_tokens`/`totalTokens`; when input and output are both available but total is absent, the Gateway calculates total as their sum. Requests without usable provider-reported usage remain explicitly unavailable rather than being represented as zero. Provider connection tests use the same request-log path and no longer depend on a separate diagnostic trace. Statistics are transport observability and do not create WorkLite Runs, Usage rows, Audit Logs, or Agent executions.

Correlation values are internal `x-worklite-*` request headers consumed by the Gateway and removed before upstream dispatch. They are never added to a Provider's `forward_headers` allowlist, so an upstream provider cannot observe WorkLite Run identity. A request-log row records one Provider-bound attempt; Gateway-internal retries across Codex accounts produce one row per upstream attempt.

Gateway statistics and request logs are read through the dedicated Logs destination rather than the Providers destination. Providers owns Provider administration and the Codex account pool; Logs owns transport observability. Both read surfaces share one explicit time range, so a reader who narrows a range on one view keeps that range when switching to the other. The request-log read model is a paged credential-safe list filtered by time range, Provider, model, status class, and correlated Run, plus one detail record carrying the captured request and response bodies. The WorkLite API proxies all three routes from the Gateway-owned store without persisting or re-deriving them:

```text
GET /api/portkey-gateway/stats
GET /api/portkey-gateway/request-logs
GET /api/portkey-gateway/request-logs/:requestLogId
```

Both list routes take an explicit absolute time range as `from` and `to` ISO-8601 instants; neither accepts a named relative window. A named window resolved on the server cannot express an arbitrary interval such as one afternoon, and resolving a relative name at request time also makes a shared link mean a different interval for each reader. Naming a preset therefore belongs to the client, which resolves it to absolute instants before the request. An omitted range resolves to the last 24 hours ending now, an inverted range is rejected, and `to` beyond the current instant is clamped to it.

The two stores answer the same range differently and the asymmetry is permanent: statistics cover the whole range because `gateway_request_stats` is retained indefinitely, while request logs cover at most the trailing three days of it. A request-log range that begins before the retention window is served as the intersection with that window rather than rejected, so a reader who narrows from statistics to request logs sees the recoverable part of the same investigation instead of an error. The API does not report the truncation as a failure; the retention constraint is stated on the read surface.

Request logs remain transport observability. They do not create WorkLite Runs, Usage rows, Audit Logs, or Agent executions, and they are not independently deletable; retention expiry is their only removal path. Because their window is fixed at three days while Workflow Run records persist, a Run older than the window retains its own node activity while its correlated Provider request and response bodies are already expired.

Statistics and request logs are transport observability and remain distinct from the WorkLite Usage read model and the append-only Audit Log, which are API-owned business records over WorkLite Runs and resource mutations. Moving observability to its own destination does not merge those surfaces or give the Logs destination a WorkLite data source.

### Persistence

- SQLite is the initial local system of record for WorkLite resources, stored in the deployment-owned `.data/deployment/` directory. Web-only development has no separate database and reaches that state through the managed deployment API. Portkey Gateway owns an independent SQLite database file (configured by `PORTKEY_GATEWAY_DB_PATH`) and dedicated `gateway_providers`, `codex_accounts`, `gateway_request_stats`, and `gateway_request_logs` tables for Gateway state; the API SQLite database is not used for Gateway Provider runtime, administration state, or Gateway statistics.
- Drizzle ORM for schemas, migrations, and type-safe queries.
- PostgreSQL, Redis, and BullMQ are deferred until multi-instance execution and durable queue requirements justify them.
- Textual skill and artifact content remains in SQLite for the local runtime. Binary archives and large payload storage are deferred until an implemented storage boundary requires them.

Core relationships use relational tables. Versioned workflow definitions and revision operations may use SQLite JSON columns. A later binary-storage increment may introduce an S3-compatible service without changing current textual artifact contracts.

### Operations

- OpenTelemetry for traces and metrics.
- Sentry for error reporting.
- ESLint with TypeScript, React Hooks, and JSX accessibility rules for static quality checks.
- Knip for unused dependency and source analysis.
- Vitest for unit and integration tests.
- Playwright for browser end-to-end tests.
- Docker Compose for the initial local and self-hosted environment.

### Managed Local Deployment

The deployment runner owns release snapshots, candidate compilation, isolated preflight, target ownership checks, managed service replacement, data backup, and matched rollback. A first deployment establishes `.data/deployment/runtime/current.json`; later operator deployments create a confirmed job in the same external journal used by Chat redeployment and synchronously wait for it to settle. The first transition from the legacy background launcher is permitted only after the isolated candidate is ready and only when the PID file and target listeners prove ownership by the repository's `start-local.mjs` process group. Unknown listeners are never terminated. If the first managed runtime fails after that legacy group is stopped, the runner restores its backup and reports failure without restarting the unmanaged service. The legacy `install-local.sh`, `start-background.mjs`, and `start-local.mjs` entry points are retired so they cannot bypass the runner's ownership and rollback boundary.

## Domain Model and Ownership

```text
Workspace (one per installation)
|-- ModelProvider
|-- Plugin
|-- Skill
|   `-- SkillVersion
|-- MCPServer
|   `-- MCPVersion
|-- Agent
|   `-- AgentVersion
|       |-- SkillVersion references
|       `-- MCPVersion and allowed-tool references
`-- Workflow
    |-- WorkflowDraft
    |   `-- EditRevision
    `-- WorkflowVersion
        `-- WorkflowGraph
            |-- WorkflowNode references NodeTypeVersion
            `-- WorkflowEdge connects typed ports
            `-- WorkflowRun
                `-- NodeRun
```

All workspace-owned records include `workspace_id`. The API resolves the singleton workspace by the requested canonical workspace slug and applies workspace filtering to every resource query. A missing slug is an error; the API never substitutes another workspace. There are no accounts, memberships, invitations, roles, or authorization checks in this product shape.

## Chat and Workflow Agent Architecture

Chat is the protected product-owned master conversation capability, reached through the first-level `/chat` workspace. It replaces the former embedded Home composer and floating Chat Bot surface. The workspace has Conversation, Channels and Configuration views. Web is its built-in channel and Feishu is an external channel; Agent configuration, persisted executions, questions and task dispatch belong to Chat, while channel adapters own identity binding, connection, receipt intake, platform rendering and delivery. Channels do not become separate Agents. The persisted Agent id `agt_system_helper_chat` and its records remain the master runtime identity.

In the implemented product, Workflow Agent nodes are the only user-configurable Agent capability. Each node owns its public model id, system prompt, output format, Skill selections, and MCP server selections inside the immutable WorkflowVersion. Workflows never reference standalone Agent or AgentVersion resources. Every Agent uses the protected `gateway-provider` binding; the binding is not a user-selectable Provider and is omitted from Provider listings and forms. Skill and MCP definitions remain reusable workspace resources, but their assignment is explicit inside each Workflow Agent node. Chat configuration is protected and is not a user-managed Agent assignment. The API validates that every selected Skill and MCP server belongs to the same workspace.

Workflow Agent nodes execute their model-tool loop through the shared AI SDK-backed Workflow Agent loop in Model Gateway. The loop preserves Workflow-owned sequential tool execution, round and tool-call budgets, final-round tool shutdown, Skill and MCP activity, streaming text, and Portkey correlation. Chat remains on its existing persisted execution state machine in this phase. This is runtime composition only: Workflow versions, Node Runs, retry, Dashboard, Artifacts, and the deterministic scheduler retain their existing contracts.

Workflow nodes are generic typed execution units. Each node references a registered Node Type and contains versioned configuration, a persisted canvas position, and declared input and output ports. Workflow edges connect one output port to one named input port. The workflow runtime assembles each node request as an object keyed by its declared input ports after every upstream dependency has completed. A Node Type declares configuration, input, and output schemas and executes behind the Workflow Engine contract. The registered node catalog is also the source of truth for node capability metadata consumed by graph validation and the workspace platform snapshot. The first-party `worklite/timer` Node Type is a source trigger with no inputs and one JSON output. Its versioned configuration contains `enabled` and `intervalSeconds`, with a minimum interval of 300 seconds, and a Workflow may contain at most one Timer node. The first-party `worklite/dashboard` Node Type is a required-input JSON pass-through with display metadata; its versioned configuration contains a `layout` with `header`, `main`, and `footer` element arrays, where each element is one of the generic element kinds `text` (static text), `count` (item total with a label), `metric` (a label, output field key, and `text`, `number`, `boolean`, or `datetime` type), or `list` (a `titleKey` plus display fields with unique non-empty `key`, non-empty `label`, and a supported `type`). A Workflow may contain at most one Dashboard node. The first-party `worklite/artifact` Node Type is the only Workflow graph unit that creates an Artifact: its required `data` input accepts JSON, its immutable configuration contains a non-empty `name` and an artifact `type` of `text`, `markdown`, or `json`, its execution persists that configured textual Artifact for the successful node run, and its output is an Artifact reference rather than the copied Artifact content. A Workflow may contain multiple Artifact nodes. The first-party `worklite/image@1` Node Type requires a string `prompt` input and generates one or more PNG images. Its immutable configuration is constrained to `model: "codex/gpt-image-2"`, a positive `n`, `background` of `opaque` or `transparent`, `quality` of `low`, `medium`, or `high`, and `size` of `1024x1024`, `1536x1024`, or `1024x1536`. Execution returns an in-memory Workflow JSON image object, not a binary Artifact; persisted logs, events, terminal results, and detail views contain only a credential-safe image summary with model, media type, and image count.

The first-party `worklite/branch@1` Node Type is a provider-independent JSON pass-through and exclusive router. It receives `value`, exposes the unchanged JSON on `output`, and uses structured outgoing edge conditions to select the first matching route in definition order, or the first fallback when no route matches.

The first-party `typesafe/systemone@1` Node Type is the Workflow entry point for the credential-forwarding TypeSafe System One protocol. It accepts a required JSON-compatible `state` input and exposes the upstream System One response, including its required typed `answers` object, through `output`. For object state, the node retains the state's top-level JSON fields and overlays the upstream response so downstream nodes can keep using the original context while routing on typed answers; for primitive or array state, the original value is exposed under `state`. Its immutable configuration contains a public `<providerName>/<modelId>` model id and a JSON `questions` object; the node does not store credentials, base URLs, or Provider ids. Runtime execution resolves the public model against the Gateway-owned Provider catalog, requires the selected Provider to use `typesafe/systemone`, and calls the internal Gateway proxy with Workflow Run and Node Run correlation headers. The Gateway request and response remain System One bodies with `model`, `state`, and `questions`; the state pass-through is added at the Workflow node boundary, not in Gateway transport. Typed answer fields can be routed with the existing structured edge paths, such as `$.answers.articleType.choice`. Existing `typesafe/systemone` Providers remain excluded from Agent model selection.

Plugins are the extension and composition boundary. A trusted in-process plugin may register Node Types, runtime capabilities, typed lifecycle events, and optional browser metadata. The Workflow Engine does not import concrete plugin implementations; it resolves a Node Type from its registry and invokes its execution contract. Plugin registration is separate from node execution: a plugin may contribute capabilities without being a workflow node.

The plugin runtime includes independent product-owned `codex-cli-chat`, `feishu-bot`, and `wechat-official-account` capabilities. They are registered by the API and stored as workspace plugin resources. Feishu is the external conversation entry for the protected Chat; it is not a Codex CLI transport. Codex execution uses the existing Agent execution, message, SSE, cancellation, and audit contracts. A plugin execution is persisted against a protected system Agent identity so the browser can reuse the existing execution viewer without exposing the plugin as a configurable Agent. Each turn starts the plugin's persisted executable command with `exec --json` through the Commands process boundary, sends the prompt through stdin, parses the final Agent message from JSONL, and stores the response in the normal execution transcript. Conversation history is included in the next turn's prompt; the plugin does not depend on Codex session files or interactive TUI state.

The `feishu-bot` capability uses the [official Feishu Node SDK](https://github.com/larksuite/node-sdk/blob/main/docs/channel.zh.md)'s outbound WebSocket connection for private-chat messages and interactive card callbacks. Configuration stores App ID, encrypted App Secret, one allowed user's open id, and observable connection state. Secrets never enter browser reads or model context. Development Web proxies to the same managed deployment API and data, so the deployment process owns the one Feishu long connection and application credentials; a development process must not start another adapter or split events. ClawBot login, polling, conversation mappings, API routes, and UI are removed without compatibility adapters. Historical Agent executions and the independent WeChat Official Account Workflow capability remain. Application permissions, subscriptions and setup order are documented in [Feishu setup](../feishu-bot/README.md).

Feishu configuration also offers device registration following the [official lark CLI implementation](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/auth/app_registration.go): one activation requests a `PersonalAgent` application, shows the platform confirmation URL and a locally rendered PNG QR, and polls on the server for credentials. A profile-local registration row persists the encrypted device code, expiry, poll interval and next poll time, and credential-safe outcome. Public reads expose only the confirmation URL and state. Completion atomically stores encrypted App Secret and the returned application-scoped user open id, then starts the connection without a second save. Missing user information stores the credentials with the connection disabled and asks only for the missing open id; an existing application's user id is never reused. Manual configuration cancels a pending registration, and stale results cannot overwrite a manual save or later registration. Cancel preserves the current configured application. The visible registration flow replaces expired codes automatically; denial and errors allow a new explicit attempt. Preflight, upgrade handoff and shutdown suppress registration network work.

Device registration creates application credentials only; it is separate from user OAuth and does not promise message permissions, long-connection subscriptions or publication. The configuration page links to the configured application's platform console for those steps and retains manual App ID/Secret/open-id configuration for existing enterprise applications. This Feishu plugin does not add cross-brand Lark support. Registration does not invoke or alter the local lark CLI, its profiles or Keychain. The SDK runtime remains the existing connection boundary; compatibility of the platform-created application and live bot operations requires an authorized integration check. Protocol evidence and the implementation boundary are recorded in [credential automation](../feishu-bot/credential-automation.md).

Chat is the master conversation Agent for Web and Feishu. Both use one server dispatch boundary: ordinary dialogue continues the protected Agent execution; an explicit Team target uses the existing Team conversation intake; a Workflow target resolves only an immutable published version. Model-driven dispatch uses the same boundary through the protected platform scripts, honors explicit targets, and asks when several targets fit. Each Feishu chat owns its own persisted Agent execution. New private messages always enter master dialogue; target selection applies only to the current task through Agent clarification and dispatch, never to later messages. The earlier persisted chat target is no longer read or changed, and no target-switch action is supported. Web and Feishu reuse configuration and capabilities without automatically merging transcripts. Durable inbound receipts and submissions preserve order and idempotent task creation. Task references, output message identifiers, and delivery state are persisted; execution evidence remains in the owning domain.

Feishu cards carry server-bound task references. Their direct actions reuse authoritative Run APIs for answering, controls, exact-command grants, recovery, and retry. Agent choices answer the currently bound question and resume that same conversation. A reply to a task card remains bound to that task’s question; choices never change an active Run or its immutable version. Team grants originate from a user card action carrying the exact command strings entered and submitted by the user, never from prose or a model-generated authorization. One active Team Run and the durable intake queue remain authoritative. Task snapshots drive progress, questions, pending-action QR images, and result files; retrying delivery does not rerun a producing role or Workflow. Accepted ordinary messages persist their response placeholder with the inbound receipt. The delivery worker shows queued state before dispatch and replaces it with thinking, responding, or processing state in the same card. Completed dialogue shows the reply without a task header or completion label; options appear only for a pending question. Feishu delivers committed Team documents or Workflow Artifacts through the existing domain delivery boundaries.

Feishu card presentation uses CardKit entities created and sent by reference, following the [official SDK's native Markdown stream](https://github.com/larksuite/node-sdk/blob/main/channel/outbound/streaming/markdown-stream.ts) and [CardKit streaming contract](https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview). New card deliveries require `cardkit:card:write`. Stable component ids separate the status, reply, question, controls and collapsed Team/Workflow execution details. Ordinary model text uses native typewriter updates with the fast rendering strategy; tool processing, pending questions and terminal outcomes close streaming before changing interaction content. Terminal dialogue removes progress and retains its reply. Neutral native icons and theme-aware text work in both Feishu themes without GIF assets or custom animation. Required questions, failures, QR images, authorization forms and recovery controls remain outside the collapsed panel.

The existing submission's rendered-card JSON persists the CardKit id, last delivered card, stream-open time, monotonic operation sequence and any pending update with its idempotency UUID and exact payload. The serialized delivery worker resumes an unacknowledged pending update with the same UUID before sending newer content, retains the existing message-send UUID, and records each platform operation and result in channel evidence. A classified platform rejection retires the pending request while preserving its sequence; the next delivery can reopen an expired stream and send current content with a newer sequence. It renews the platform's ten-minute streaming session while a model reply is still running. Structural transitions replace the card, while ordinary text/status changes update only their components. Existing message cards without a captured CardKit id are not converted or recreated; an unfinished legacy card requires a new request, and a permission failure does not silently fall back to whole-message updates. This transport change does not alter Agent behavior, domain task grants, dispatch, recovery or file delivery.

Chat channel discovery is exposed through `GET /chat/channels`. Chat conversation discovery is server-owned: `GET /chat/conversations` returns cursor-paged persisted master executions, direct Web task submissions and external chats awaiting their first execution, with channel provenance; `GET /chat/conversations/:id` exposes the selected conversation and its current persisted execution; `GET /chat/conversations/:id/records` returns the complete execution snapshot, persisted Agent events, inbound and outbound channel receipts, submissions, rendered cards and delivery identifiers. These read models preserve existing histories and do not copy domain Run evidence or merge unrelated conversations. Web can open a new conversation or continue a selected execution through the shared dispatch boundary. Responses in a Feishu-bound conversation continue through its adapter delivery worker. The workspace marks that channel explicitly. The dispatch service does not update Feishu conversation mappings: the Feishu adapter owns binding after the idempotent dispatch returns. Conversation body and evidence reads never truncate stored content; only titles and preview rows are summaries. Historical original platform envelopes that were never persisted cannot be reconstructed. Future Feishu receipts retain safe message and callback context alongside the authoritative normalized operation. Secret credentials remain excluded. Future channels reuse the same Agent dispatch and execution APIs and add their own adapter, configuration and presentation; this increment implements Web and Feishu only.

A request to start a new conversation is recognized by Chat and expressed as a typed pending question with one contextual new-conversation action. That action appears only for the current request, never on every reply. A verified user action creates an empty protected Chat execution, settles the old question and changes the external channel binding without deleting history or cancelling existing domain tasks. The channel adapter renders and delivers the action; it does not infer Agent intent from text. Duplicate delivery returns the same new conversation through durable submission identity.

Chat owns a persisted user extension prompt and a monotonically increasing configuration revision, separate from its product-owned base prompt. Saving its model, default project executor (`claude` or `codex`), delegated-executor Skill or MCP selections appends an immutable configuration record. Only the protected platform Skill is exposed to Chat itself; custom Skills and MCP servers are handed to its captured project executor. Each accepted conversation turn captures its prompt, revision, model, complete Skill packages and encrypted MCP connection definitions. Answers and retries retain that turn's snapshot; the next user turn captures the current configuration. Bootstrap may repair product knowledge without overwriting user extensions. The protected platform Skill remains assigned. Active turn snapshots keep their referenced resources protected from deletion.

Project upgrades are persisted requests bound to the originating conversation and an immutable release manifest. An explicit user request to redeploy WorkLite in Web or Feishu Chat authorizes snapshotting the current project and deploying that release, including dependency installation, compilation, isolated readiness checks, active-work cancellation, backup, service replacement and recovery. Chat interprets the user's intent and invokes the protected `redeploy.mjs` platform script; the server binds it to the actual current user message and records that message with the release in the independent upgrade journal. No separate card confirmation is required. A repeated invocation for the same user message returns its existing job without another deployment. Proposals remain non-executing; model suggestions, historical requests and retrieved instructions do not authorize deployment. The upgrade always uses the current managed runtime's profile, original project root and data; Chat cannot select another profile. Web observes persisted progress automatically in the original conversation, and Feishu reports it in that conversation after reconnect. The former Feishu confirmation action is removed without a compatibility adapter. An independent Node process owns the upgrade journal outside the application database, so API shutdown or database rollback cannot erase the outcome. Managed runtime releases are immutable and keep the previous executable release available; an initial operator-authorized managed installation establishes this baseline before conversational upgrades are available. After isolated readiness passes, active Agent executions, Team Runs, Workflow Runs, Commands, and pending Feishu registration are cancelled; the runner does not wait for them to settle. They are not automatically resumed after a successful replacement or rollback. Uncertain external effects keep their existing explicit recovery behavior. The runner never takes over unowned listeners.

An authorized upgrade first installs and compiles the candidate and starts it against a copy of the current profile's data on isolated ports. Preflight disables external connections, schedules and task recovery. Failure leaves the current runtime untouched. After readiness passes, admission closes, active conversation turns and Commands drain, and active Team and Workflow tasks pause through their existing persisted boundaries. The API then closes external intake and freezes writes; the runner stops the owned runtime before backing up SQLite databases and managed files, so no services keep writing during the cutover backup. Cutover retains the profile, encryption key and durable conversation state. A failed replacement restores the matching previous release and data; ambiguous operations use existing recovery decisions rather than replay. Only tasks paused by this upgrade are resumed. The new or restored API reconnects Feishu and updates the original request card. A short cutover disconnect is accepted; receipt persistence guarantees only events WorkLite has received, and uninterrupted ingress is outside this increment. Development managed preflight uses ports `3490`–`3492`; deployment managed preflight uses `23490`–`23492`. Neither is a compatibility listener. Operational details are in [conversational upgrades](../feishu-bot/upgrades.md).

The Codex CLI plugin owns an editable executable command configuration, defaulting to `codex`, in the persisted Plugin row. The value contains one executable name or path followed by optional fixed leading arguments. The API parses that value into an argument vector without shell operators, expansion, or environment-variable substitution, uses the same vector for availability probing and execution, and appends its product-owned `exec --json` arguments afterward. It never reads a command override from an environment variable. The command is executed through the existing shell command boundary with each parsed value quoted independently, using the API process working directory and inherited process environment to match the existing Host Command Interface. The browser exposes Plugins as a first-level workspace resource with a dedicated list and configuration page; saving and testing are server-owned operations. The Feishu channel configuration lives in `/chat` under Channels, and is excluded from the Plugins collection; saving credentials starts its connection and observable state updates automatically. The former `/plugins/feishu-bot` Web configuration route is removed without a redirect. Existing configuration APIs and encrypted transport-owned persistence remain in the plugin runtime. Skills and MCP servers remain capability resources, while Model Providers remain in the Providers destination. There is no user-uploaded plugin code or marketplace installation. Feishu application registration does not introduce user OAuth or general network authorization. Existing `codex` values remain valid without migration. Existing Workflow and execution records remain valid without migration; startup bootstrap adds or repairs the protected plugin row and Chat configuration without removing user data.

Agent is one Node Type rather than the Workflow Engine's universal primitive. The first-party `worklite/agent` adapter stores a public `<providerName>/<modelId>` model id, system prompt, Skill identifiers, and MCP server identifiers directly in its immutable WorkflowVersion configuration. Its configuration also owns `outputFormat` as `text` or `json`, with `text` as the default. JSON mode parses the final Agent response as JSON and accepts an optional fenced JSON block, but rejects surrounding prose; invalid JSON fails the Agent node. JSON mode additionally owns an optional `outputContract`: a non-empty array of unique non-empty strings naming top-level keys the parsed object must carry. When present, the parsed output must be a JSON object and every named key must exist with a value that is not `null`, an empty string, or an empty array; a missing or empty key fails the Agent node with an error naming the absent keys. Parsing alone accepts any valid JSON, so without a contract a node can commit a value that is well-formed but is not its intended result, such as a progress note or a tool-call object, and every downstream node then consumes that value as if the node had succeeded. Contract failures use the node's ordinary `errorPolicy` and the existing failed-node retry path and introduce no separate failure state. The contract is a presence check on top-level keys only; `inputSchema` and `outputSchema` remain capability metadata that the runtime does not enforce, and full JSON Schema validation for node inputs and outputs remains a separate architecture decision. For evidence-heavy Agent nodes, optional positive `maxToolCalls`, `maxToolRounds`, and `maxToolResultChars` limit actual script/MCP invocations, tool rounds, and text returned to the model and model tool rounds; after the budget is spent, the runtime removes tools and asks for a final answer from collected evidence, and does not execute excess calls in a batch. An optional `passthroughKeys` list on JSON-mode Agents copies the specified top-level keys from the input context into the parsed result after model output validation, so an editorial model cannot rewrite the writer's article or evidence. Its `context` input defines one isolated invocation. The adapter returns only text or parsed JSON through the generic node result without separate Workflow output persistence and does not create Artifacts. It reuses shared Agent Runtime infrastructure without creating or referencing Agent or AgentVersion records.

Workflow publications independently lock the complete embedded Agent node configuration, so later draft edits cannot alter published workflows or historical runs.

Gateway Providers are installation-scoped resources and are presented in the Providers destination through the WorkLite API proxy. Provider configuration uses a user-supplied `baseURL`, a namespaced protocol such as `openai/chat`, `openai/responses`, `anthropic/messages`, `codex/responses`, or `typesafe/systemone`, an API key for ordinary upstreams, a model catalog, and optional headers. Header values and ordinary Provider API keys are encrypted or protected by the Gateway storage boundary; the Codex access token and private Codex headers are Gateway process environment configuration and are never persisted in Provider records. WorkLite API responses return only header names, masks, and counts. Provider changes take effect on the next request and do not mutate immutable published workflow versions. New Provider forms require an explicit protocol selection and do not prefill one.

Provider connection tests are synchronous, bounded smoke tests through the same model gateway used by runtime execution. `POST /api/portkey-gateway/providers/:providerId/test` requires one model from the Provider's current catalog and validates that explicit selection. Chat-compatible protocols send the fixed read-only chat prompt and limit output; `typesafe/systemone` sends a fixed typed `state` and `questions` payload and returns the typed `answers` payload without chat adaptation. Each transport applies its own bounded timeout. The server does not select a fallback model. Remembering the last tested model is browser-local presentation state keyed by Provider id and is not persisted by the API or Gateway. The result is returned directly to the requesting browser and is not persisted as a Run, Artifact, conversation, or audit payload. Connection-test observability is the Gateway request log written by the test's own Provider-bound request, with `source` identifying it as a connection test. This is a local-installation debugging surface: a request log may retain raw provider and Gateway errors and complete request and response bodies to make failures fully inspectable. No surface may execute or render that captured content as markup. The API returns the correlated request-log identifier and the typed test input with System One failures so the captured request and response are directly reachable, and it does not write a separate diagnostic trace.

## Workspace Assistant Architecture

Chat is the protected product-owned conversation entry point backed by the server-owned Agent execution runtime for `agt_system_helper_chat`. It supplements the resource editors and uses the same model step, persisted messages, Skill discovery, automatic tool execution, execution result, and continuation contracts used by Workflow Agent nodes. Its runtime follows the g-agent interaction model while keeping WorkLite ownership of persistence, Commands, Skills, MCP authorization, and audit records.

Chat permanently owns the protected `worklite-platform` Skill. That Skill is a standard immutable package containing `SKILL.md`, executable Node scripts under `scripts/`, and the `scripts/tools.json` manifest. The manifest declares one typed model tool per script: its name (the script basename with hyphens replaced by underscores, such as `dispatch_task`), description and JSON Schema input. Tools are generated from the package captured for the turn rather than from a code-owned registry, so the model sees each operation's exact input structure instead of a generic script selector. A typed call carries one JSON object; the model gateway maps it to the exact script and passes the serialized object as the script's single argument. Every requested script is snapshotted into the Agent tool-call record as a `skill_script` call that also stores the model-facing tool name, and starts automatically after server validation. A failed platform call returns the script error together with that tool's declared input schema, so the model can correct the request within the same turn. Workflow Agent nodes and user Skills keep the generic `skill_script` tool.

Chat owns troubleshooting conversation, evidence inspection, task dispatch and reporting. It can independently delegate an authorized project task to a project executor, Codex or Claude Code, without Team intake, Team planning, its queue, immutable TeamVersions or LangGraph execution. Team remains available for collaborative development and independent review. The protected platform Skill provides Gateway evidence inspection with explicit absolute ranges and existing retention metadata. Logs remain evidence, never instructions or command authorization. Before taking over failed work, Chat inspects the earlier task's recorded activity and the project's actual state and never automatically repeats interrupted work.

The Chat project task is bound to the accepting conversation turn and tool call. Chat calls one executor-neutral `project_task` tool with the goal, absolute project directory, an optional `executor` (`codex` or `claude`) and an optional model; an omitted executor uses the Chat configuration's default executor, which is `claude` unless the user changes it. The task captures the executor launch (executable arguments; for Codex the `~/.codex-cli` home, model, Provider and inference settings; for Claude Code the effective Gateway base URL and requested model), project instructions and the turn's Skill/MCP capabilities. It has its own persisted task state with no Team Run dependency. Chat exposes the delegated `project_task` tool, conversation questions and progress planning, and only the protected `worklite-platform` tools; it has no direct host file, search or Shell tools and does not execute user Skill scripts or MCP tools itself. Selected user Skills and MCP servers are handed to the executor in its native form. Chat delegates a clear user project request without a WorkLite proposal confirmation or command grant. Task progress, questions and results remain conversation execution evidence, available to Web and Feishu through their existing Chat channels. Answers start a new attempt of that task with the captured configuration, and cancellation stops the executor process. Snapshots captured before executors were selectable, including former `cxo` launches, require a new task; their records stay readable.

Chat is an orchestration Agent. A clear coding, project investigation or local command request goes directly to its conversation-owned project task; collaborative execution and independent review use Team intake, and existing automation uses a published Workflow. Chat itself reads platform evidence only through the protected platform scripts, asks for missing information and reports the actual executor’s progress and results. User extensions and selected Skills/MCP servers cannot reopen host tools or arbitrary script execution. Historical Shell calls retain their output and explicit uncertain-effect recovery; their retries cannot launch another Command. No new Shell proposal question or direct execution is available.

Chat and Team developer tasks share one project-executor boundary with two backends. Each executor runs in the real project directory with its own native tools, under the operator's complete local configuration, and without approvals: WorkLite provides no tools to it and disables none of its built-in tools. Codex runs through the [App Server](https://github.com/openai/codex/tree/rust-v0.157.1/codex-rs/app-server) over stdio JSON-RPC with `CODEX_HOME=~/.codex-cli`, `approvalPolicy: never` and `danger-full-access`, matching the operator's `cx` alias; `cx` is the only Codex launch form, and the former native `cxo` form is removed. Its model must be a current Gateway public id on an `openai/responses` or `codex/responses` Provider, and the home's Provider must point at a WorkLite Gateway loopback port. Claude Code runs as `claude -p` with the stream-json input and output formats and the control protocol used by the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python/blob/a8e7ce3/src/claude_agent_sdk/_internal/transport/subprocess_cli.py), with `bypassPermissions` and the operator's `~/.claude` configuration; its effective `ANTHROPIC_BASE_URL` must name a WorkLite Gateway loopback port and an explicit model must be a Gateway public id on an `anthropic/messages` Provider. Selected Skills are materialized into a task-scoped temporary directory and registered natively (Codex `skills/extraRoots/set`; a Claude Code `--plugin-dir` plugin); selected MCP servers are added natively (Codex `-c mcp_servers.<id>` with `enabled_tools` and an environment-variable bearer token; a Claude Code `--mcp-config` file written with owner-only permissions and removed afterwards, plus `--disallowedTools` for tools outside the captured allowlist). Credentials never enter command arguments. A Claude Code `AskUserQuestion` request and a Codex user-input request become the task's pending question. Executor effects happen natively, so WorkLite keeps no operation journal for them: it records the executor's own event stream (commands with exit codes, changed files and tool calls) as task activity, links the executor process Command, and on interruption or API restart marks the task failed without replay, leaving the project state for inspection. Gateway correlation headers identify the source and Team Run. Minimum versions are Codex 0.157.1 and Claude Code 2.1.259.

Platform scripts run as child processes through the shared Skill and Commands runtime. They never import Nest services or access SQLite directly. The API process exposes its loopback base URL and workspace slug to every Skill invocation as server-owned context. `worklite-platform` scripts use the built-in Node `fetch` API to call the same typed resource and settings endpoints used by manual forms. This preserves server validation, domain ownership, audit behavior, and independence from the Web client. Every platform script accepts one serialized JSON object argument; a script without input accepts `{}` or no argument and rejects any field. The manifest schema and each script's own validation describe the same contract, and the script remains the authoritative execution-time check. Scripts validate their operation-specific structure, and print one JSON result containing the affected resource and route. Workflow mutation scripts forward complete node configuration strings without application-level character limits.

Initial scripts inspect the credential-safe workspace snapshot; create non-secret Provider, Skill, MCP server, and Workflow drafts; update persisted appearance or language settings; and validate a requested navigation target. Provider credentials and custom-header values are never accepted by the scripts, model context, Agent tool-call arguments, ordinary logs, or errors. A created Provider result directs the user to the secure Provider form for credentials.

Navigation is the only client-actuated result because a server process cannot move a browser. The navigation script calls a server allowlist endpoint and returns a typed client action containing the resolved route. Agent execution stores this parsed action with the completed tool call. Web may apply only that server-returned action and must not infer navigation or operations from model text or raw stdout. Appearance and language are persisted server settings; Web reads and applies the resulting state instead of owning the mutation.

Chat conversations are persisted as ordinary mutable Agent executions, not Runs or Artifacts. The browser remembers only the selected conversation identifier for navigation. Unsent drafts and removable queues survive route navigation in browser-session memory and disappear on reload; it does not own messages, operation ordering, cancellation state, or mutation state. Creating or continuing an Agent execution persists the complete non-empty user message without application-level character or per-execution message-count limits, schedules the turn in the API process, and returns the `running` execution immediately. Agent model steps do not impose a WorkLite output-token cap or forced timeout and remain cancellable through the normal turn-cancellation route. Transport request-size limits and the selected Model Provider's context and generation boundaries remain authoritative external constraints, so accepted long messages may still fail during provider execution. A new message may be submitted after the current turn reaches `completed`, `cancelled`, or `failed`; a failed execution clears its error when a follow-up starts. A `skill_script` request keeps the execution `running`, starts the validated script immediately, and returns its result to the same model turn before another tool request or final response.

Chat project task inspection is a bounded read model over the persisted task. Task views and replayable Agent execution snapshots include the executor, task status, result and error, activity counts with the latest 20 activities, and, for tasks recorded before executors used native tools, their retained operation metadata. The protected `inspect_project_task` tool returns this summary and accepts an optional operation key for one retained historical operation. `/chat/conversations/:id/records` returns the latest execution snapshot and every other retained event, omitting only superseded snapshot events; full task records remain available through their owning read routes. When a `skill_script` result is returned to the Chat model loop, its output is capped at 60,000 characters with an explicit note that the complete output remains in the persisted Command record.

Codex final responses use strict JSON parsing first. If that fails, the parser retries after escaping raw JSON control characters inside string values. A response that still cannot be parsed leaves the task failed with a distinct invalid-JSON error and preserves the original response text in `result` for inspection. This does not replay any journaled operation.

Chat owns one protected Agent capability with separate per-session transcripts. It delegates coding, project investigation and local command tasks to its own project tasks, dispatches collaborative requests through server-owned Team intake and automation requests through immutable published Workflow versions. Project tasks are conversation-owned execution evidence, not standalone user-managed Agents or child conversation sessions. `@` mentions invoke published Workflows only; the remaining message text becomes the Workflow input and the resulting Run remains separate from Chat execution history.

The API process owns in-memory scheduling and cancellation handles, so an interrupted process cannot resume a previously running turn. Database initialization changes every persisted `running` execution to `failed` with a stable restart-safe error while preserving its messages. Running Skill calls, MCP calls, and built-in host calls are also marked failed so the restart is visible after reload. Interrupted Chat Shell calls retain their unresolved tool result and reserved Command for explicit recovery. Execution views persist a safe diagnostic phase and error code alongside the safe localized error message; terminal transitions write audit metadata containing the execution, tool-call, command-execution, and background-task identifiers without provider responses, stack traces, credentials, or raw SDK errors. This normalization is a forward runtime rule for existing records; no compatibility route, text command, or migration adapter is provided.

Agent execution progress is delivered through a reconnectable Server-Sent Events endpoint at `GET /agents/:agentId/executions/:executionId/events`. Agent events are persisted with monotonically increasing execution-local sequence numbers and replayed from `Last-Event-ID`; a new stream begins with the latest persisted execution snapshot and its following uncommitted deltas, tool lifecycle events and terminal status events, rather than replaying earlier turns. Existing create, continue, answer, retry, cancel, and execution-read REST endpoints remain authoritative for commands and snapshots. Browser disconnection never cancels execution. Existing executions without event history receive a snapshot on first connection; future events are recorded without reconstructing historical token deltas.

The model gateway exposes `codex`, `update_plan` and `ask_user` plus one typed tool per protected platform script to Chat. Custom Skill scripts and MCP tools are available only to delegated execution, not the Chat model loop. Agent Team roles receive their existing role-specific built-in tools, including `write` and exact-command-authorized `bash` for the roles that perform work. `update_plan` is persisted execution state. `ask_user` is available whenever a material user choice or missing information blocks the current request, including ordinary dialogue without a plan. It is requested alone, pauses the execution, and resumes it through a typed answer route. The dedicated clarification pass after a new multi-step plan remains restricted to planning and questions. OpenAI-compatible Agent model requests disable provider-level parallel tool calling so host operations are requested sequentially. The runtime retains a maximum of four tool calls in one model step as a defensive boundary and reports `too_many_tool_calls` with an actionable credential-safe reason when a provider ignores that request. The gateway rejects invalid or incomplete tool calls before their response messages enter Agent history, classifies malformed JSON separately from other schema-invalid requests, and exposes only stable credential-safe errors. The Agent runtime immediately marks the active turn `failed` or `waiting_for_input` and persists an actionable safe error message with a phase and error code; it never persists malformed tool input, SDK exceptions, provider response bodies, stack traces, credentials, or meaningless residual model text as a display message. A failure already committed for the turn is terminal and cannot later be replaced by cancellation. A single execution may have only one scheduled advance at a time, and every asynchronous continuation rechecks the persisted state before writing.

Web exposes one neutral Cancel action for a running or ordinary waiting-for-input Chat turn. During execution it occupies the Send target; while a question is pending it sits beside Send so answering remains available. Cancellation reports progress locally, pauses the browser queue, clears ordinary pending questions and cancels the linked Codex task. Uncertain-effect recovery stays explicit and is not cleared by Cancel. Messages and existing effects remain evidence.

The public turn-cancellation route is `POST /agents/:agentId/executions/:executionId/cancel`. A failed execution can be restarted in place through `POST /agents/:agentId/executions/:executionId/retry` without appending a duplicate user message. Cancellation is scoped to the active turn, not the reusable conversation. During a model step, the API aborts the active provider request. During a Skill or built-in host step, the Agent tool call stores its Command execution identifier immediately and cancellation delegates to Commands so the process group is terminated. During an MCP step, cancellation aborts the request through the MCP client. The execution and active tool call become `cancelled`, no later callback may overwrite that terminal state, and a cancelled tool result is persisted without resuming the model. The conversation history and browser draft remain available for the next message. Browser disconnection alone still does not cancel execution.

Helper turns use a bounded, abort-aware exponential retry for transient provider and MCP transport failures. Retries happen before a tool call is committed and never replay a committed host side effect. The runtime maintains a maximum tool-round budget per turn and emits a stable failure when the model does not converge. Full display history remains persisted; context accounting may trim the oldest low-priority messages from the provider request only, preserving the first user task and the most recent message. The trim decision is recorded as execution metadata so the browser can explain reduced context without deleting the conversation.

The protected helper may create recurring background tasks through `schedule_task`, `unschedule_task`, and `list_scheduled_tasks`. Tasks are workspace-scoped, persisted, isolated from the main conversation, and run through the same Agent Runtime with their own execution history. A task never moves the browser or writes credentials; updates are surfaced through the task list and unread state. Overdue tasks are resumed once after restart and then continue on their configured interval.

## Skill Architecture

A skill is a workspace-scoped, versioned package that may contain:

```text
SKILL.md
scripts/
references/
assets/
```

The product supports creating a Skill online and editing a real textual package. Every package must contain one root `SKILL.md`; user Skills may also contain text files under `scripts/` and `references/`. Empty directories are derived rather than persisted. Binary assets, archive upload, validation, immutable publication, and additional file roots remain hidden until their operations exist end to end. Protected built-ins expose their product-owned package files through the same file contract and remain read-only and non-deletable. An executable built-in may include product-owned shebang-bearing files under `scripts/`; immutability does not prevent execution.

`skill_files` is the canonical mutable package-file store. The Skill row retains an instructions projection of `SKILL.md` for Agent prompt assembly. Package writes validate normalized relative POSIX paths, reject traversal, duplicate paths, unsupported roots, oversized files, and packages without `SKILL.md`, then update the file set and instructions projection atomically. Startup backfills the current `instructions` value into `SKILL.md` for existing Skills and repairs built-in package files.

An assigned Skill contributes its `SKILL.md` to the Agent system prompt. Files directly below or nested under `scripts/` are executable only when they begin with a Unix shebang. The model receives a server-generated allowlist of script identifiers, selects one exact Skill id and script path, and supplies a structurally validated string argument array without WorkLite item-count or per-item character limits. It cannot submit an interpreter, working directory, environment, or unlisted script through the Skill-script tool. The API revalidates the Agent assignment and selected file before persisting and immediately starting the invocation. Transport, provider, operating-system argument, and process-memory boundaries still apply.

A saved Skill script, including a script in a protected built-in package, may also be started directly from the Skill editor through `POST /skills/:skillId/executions`. This direct path validates the persisted Skill and exact shebang-bearing `scripts/` file, accepts only a string argument array, snapshots and materializes the persisted package, and delegates execution to Commands. Clicking `Run` is the execution decision; it does not require an Agent assignment, Model Provider, model selection, or a second approval step. Unsaved browser edits are never executed, so the editor disables direct execution until the package is saved. The page observes the resulting persisted command events, exit state, and cancellation through the server API without owning the process lifecycle.

Before execution, the API persists the selected script metadata and a snapshot of every text file in that Skill package. It materializes that snapshot so the database-backed package can be invoked, then delegates the invocation to the Commands module without a browser decision. The command still runs from `process.cwd()` with the API process's complete environment and host permissions; the materialized package is an input representation, not a sandbox or working-directory boundary. The temporary package material is removed after completion or failure.

Every valid Skill-script request starts automatically and remains bound to one snapshotted invocation. The browser displays the Skill, script path, argument list, status, output, and host-permission warning but does not authorize or reject execution. Direct host execution is not a security sandbox: a script has the WorkLite process user's host filesystem, environment, and network permissions. Binary package files remain deferred.

The protected built-in Skill `worklite-platform`, with the stable identifier `sk_worklite_platform`, is a product-owned Chat capability rather than a workspace Skill assignment. Startup replaces its complete product-owned package and repairs its protected binding. It cannot be edited, deleted, published, uploaded, or manually assigned. Its execution authorization comes only from persisted shebang-bearing scripts.

The package supports credential-safe workspace inspection, constrained navigation, creation of Model Provider, Skill, MCP server, and Workflow drafts, and persisted appearance or language changes. Resource scripts reuse normal typed domain APIs through the loopback server. The package does not expose arbitrary external URLs, direct database access, resource deletion, unrestricted update operations, terminal execution, credentials, or assignment management.

The protected built-in Skill `terminal-command`, with the stable identifier `sk_terminal_command`, is a standard executable Skill package containing product-owned `SKILL.md` and `scripts/run.sh` files. The script accepts exactly one non-empty command string and delegates it to `/bin/sh -lc`. Startup replaces the complete built-in package with the product-owned files, so it cannot acquire editable behavior while remaining visible and directly executable in the Skill editor.

The generic executable-Skill discovery finds `scripts/run.sh`, adds that exact script to a configured Workflow Agent node's `skill_script` allowlist, and lets the model supply the command as the script's single argument. A valid request executes immediately with the API process user's unrestricted host permissions. Direct execution from the Skill editor follows the same server runtime after the user clicks `Run`.

The Commands module uses the API process's current working directory and complete environment, persists uncapped stdout and stderr events, and provides process-group cancellation. Agent tool-call records link each validated invocation to the resulting command execution. A command can access and return any host data available to the WorkLite process user, including inherited environment values.

Agent execution uses a server-owned session for the protected Chat and for isolated Workflow Agent node turns. The browser sends user messages, the API resolves the saved Agent, its assigned Skill instructions and executable Skill scripts, and the model gateway returns normalized text and tool-call steps. A valid `skill_script` tool call is persisted as `running`, delegated once to Commands immediately, and linked to the created Command before waiting for completion. If the turn remains active, the matching result resumes the same Agent turn and another tool request may then execute through the same sequence. Agent executions and tool calls use `running`, `completed`, `failed`, and `cancelled` runtime states and are mutable runtime records rather than immutable AgentVersions or WorkflowRuns. In-memory abort controllers coordinate active model cancellation in the initial single-process runtime; persisted state remains authoritative and every asynchronous continuation rechecks it before writing. There is no public Agent tool-call decision route. The former approval route, `pending_approval` and `rejected` states, `terminal_command` model tool, System Helper proposal stream, and pending-call behavior are removed without aliases or adapters; existing pending approval sessions are not migrated and must be replaced with new executions. Existing command execution history remains ordinary Commands data.

A Workflow Agent node uses the same model gateway, Skill-script runner, and MCP runtime without creating a conversational AgentExecution. The node resolves only the Skill packages and MCP servers selected in its configuration, adds Skill instructions and exact executable script allowlists to its system prompt, and executes one requested tool at a time. Script results are appended to the isolated node model context until the model returns final text or reaches the bounded workflow tool-round budget. Commands persist each host invocation, while the Workflow NodeRun persists the assembled port input, final output, failure, and cancellation state. Workflow cancellation aborts the active model request and terminates an active Skill command before it can resume the node.

## MCP Architecture

MCP servers are workspace-scoped and versioned. Remote Streamable HTTP transport, protocol negotiation, tool discovery, and tool calls use the official `@modelcontextprotocol/sdk` client rather than a WorkLite-specific protocol implementation. Arbitrary user-supplied `stdio` processes are deferred because they require stronger isolation and operational controls.

The configuration flow is:

1. Enter endpoint and authentication configuration.
2. Test the connection on the server.
3. Discover available tools.
4. Select the tools agents may use.
5. Publish an immutable MCP version.

The web configuration exposes workspace-scoped create and update operations for a draft. They persist name, endpoint, allowed tool names, and optionally the write-only authentication token. Credential-safe reads return the endpoint and allowed tool names so an existing draft can be edited accurately. A server-owned connection-test operation uses the saved or submitted configuration, performs real protocol negotiation and tool discovery, and returns classified connection state plus discovered tool metadata. Saving a draft is not described as publication.

Secrets use a secret-storage abstraction and must never be returned in full or written to ordinary logs. MCP output is untrusted input. Tool calls must be authorized and auditable.

Assigned MCP tools are resolved lazily when an Agent turn starts and are exposed to the model alongside built-in and executable Skill tools. The runtime records the server, tool name, sanitized arguments, result status, and cancellation state in the same Agent tool-call table. Connection failures are classified without persisting upstream response bodies. A disconnected MCP client is re-created for the next turn; an in-flight request is aborted on turn cancellation and never resumes a model step after the execution has become terminal.

## Workflow Architecture

### Research Workflow Seed

The GitHub Technology Trend Research Workflow seed composes Workflow Input, read-only Artifact Query, four embedded Agent roles (topic, collector, writer, reviewer), a cover-prompt Agent, a deterministic `worklite/approved-article@1` extraction node, and two Artifact nodes. The seed resolves existing named Skills and public Gateway models in the target profile without copying credentials. Planning and cover use a fast model, research and writing use a capable writing model, and independent review uses a different provider family when available. A less reliable review provider may retain its ordinary retry policy.

The collector uses bounded tool calls and rounds and compact research results; it gathers mechanism evidence from repositories, commits, issues, and relevant community sources, preserving historical candidate metadata from Artifact Query. Exhausted or failed tools require reporting evidence gaps rather than repeated calls. The writer produces a structured JSON draft containing title, topic, thesis, evidenceUsed, candidates, and the original Markdown article. The reviewer returns only `approved`, `duplicate`, `matchedArtifactIds`, and at most three actionable feedback items. The runtime carries the writer's article, title, topic, thesis, evidenceUsed, and candidates unchanged into the reviewer result. One rejection can return to the writer for one revision; a second rejection reaches the deterministic article gate and fails the Run without creating the final Article Artifact or WeChat draft.

The `worklite/approved-article@1` node accepts the reviewer JSON at a required `context` port, requires an explicit true approval and false duplicate, and returns the original Markdown article only when its Markdown headings and fenced code blocks are structurally sound. It never repairs corrupted text or infers an approval. A failed gate uses the ordinary failed-node retry path. Research Notes Artifacts remain separate; the approved Markdown article fans out to the Article Artifact, cover-prompt Agent and WeChat v2 draft node. The cover prompt drives `worklite/image@1`; the generated PNG is passed to the draft node. Published Workflow versions remain immutable: existing versions and historical Runs are not rewritten, and the new seed requires an updated runtime and a newly published Workflow version before it takes effect. No compatibility node or migration is added.

### Workflow Graph Model

A workflow is a directed control-flow dataflow graph of generic nodes and explicit port-to-port edges. Each node has a stable identifier, Node Type identifier and version, JSON configuration, persisted canvas coordinates, and an error policy limited to `stop` or `retry`. Each edge has a stable identifier, source node and port, target node and port, an optional structured condition, and an optional positive `maxTraversals` bound.

The graph permits any number of incoming edges for each named input port and any number of outgoing edges from an output port. Edge cardinality is an authoring decision rather than an engine-enforced invariant: the scheduler queues tokens per input port, so a port that receives two tokens produces two independent invocations, and a port that receives one produces one. Mutually exclusive branches therefore converge on a shared port by carrying predicate or fallback conditions that let only one edge deliver a token, and the first-party `worklite/branch@1` node that routes to exactly one successor is the intended way to express a JSON choice. Two unconditional upstream nodes may also target one port, which deliberately means that the target runs once per delivered token rather than waiting for both. The engine does not infer which of these the author meant and does not verify that conditions are exhaustive or disjoint.

An Agent `context` port additionally accepts one unbounded initial upstream edge plus one bounded feedback edge as a single sequential pair. The initial edge may have an output predicate when its source is not Workflow Input. An explicit Workflow Input edge must connect `worklite/input.output` to `worklite/agent.context`, remain unconditional and unbounded, and never coexist with another unbounded incoming edge. An edge without a condition always matches. A predicate condition reads a dot-delimited path from the source node's committed output and compares it with a JSON value through one of the supported operators: `equals`, `notEquals`, `truthy`, `falsy`, `exists`, `notExists`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, or `lessThanOrEqual`. A fallback condition matches only when no unconditional or predicate edge from the same source execution matches. Conditions are data, not executable JavaScript, and never use `eval` or user-supplied code.

Cycles are valid only when every possible cycle crosses at least one edge with a finite `maxTraversals` value. Validation removes all bounded edges and requires the remaining graph to be acyclic, which guarantees that an execution cannot remain inside an unbounded cycle. Self-connections, duplicate connections, connections to unavailable or type-incompatible ports, and non-positive traversal bounds remain invalid. Existing edges with no condition or traversal bound remain ordinary unconditional forward edges.

The API validates the complete graph and the Workflow Engine executes it through a deterministic sequential token scheduler. Nodes with no unbounded incoming edges and no connected required inputs seed the ready queue in definition order. The Workflow Input node therefore seeds normally and can deliver its committed output through an explicit Input edge. An Agent whose only incoming context edge is bounded still receives an initial invocation from Workflow input without prematurely starting required-input nodes. A matching edge sends the source output to its named target port. A node becomes ready when every connected required input port has one token; executing it consumes one token from each connected input used for that invocation. Optional connected inputs are consumed when available. An Agent `context` with an explicit Workflow Input edge consumes that edge's initial token; otherwise, when it has no unbounded incoming edge, it uses the Workflow Run input for its initial invocation. Bounded-loop tokens are consumed on later invocations. Definition order is the stable tie breaker whenever multiple nodes become ready. A `worklite/branch@1` invocation returns its `value` input unchanged; the scheduler then traverses only its first available matching non-fallback edge in definition order, or its first available fallback edge when no non-fallback edge matches. A node may execute multiple times in one Run, and every invocation creates a distinct ordered NodeRun.

The scheduler persists its ready queue, pending input tokens, edge traversal counts, latest outputs, terminal outputs, and next execution position in the WorkflowRun. Human-gated nodes suspend without discarding this state and resume the same invocation after input completes. A Run succeeds when the ready queue is empty and no node can become ready. Its final result is keyed by nodes whose latest successful invocation did not traverse an outgoing edge. Large values are represented by Artifact references rather than copied into every node record. Only successful `worklite/artifact` node execution creates an Artifact record.

The first-party Node Types are discovered from the trusted registered node catalog at runtime. Capability metadata includes the public type and version, display name, purpose, input and output port metadata, and configuration schema. Only registered/trusted node types are executable or usable in a workflow; this first phase does not load arbitrary remote node code or frontend components. The current first-party Node Types are:

- `worklite/input` exposes the WorkflowRun input through `output` and may explicitly connect to an Agent `context` as that Agent's initial token.
- `worklite/agent` owns its model, system prompt, Skill selections, and MCP server selections, accepts an optional `context`, and exposes the isolated invocation result through `output`. It exposes text or parsed JSON only and does not create Artifacts. In JSON mode it may declare an `outputContract` naming the top-level keys its parsed output must carry, and a parsed object missing any of them fails the node.
- `worklite/branch@1` accepts required JSON on `value`, returns that value unchanged through `output`, and selects only the first matching outgoing conditional route in edge-definition order, or the first fallback route when no conditional route matches. It is provider-independent and can route any JSON-producing node output.
- `worklite/artifact` accepts a required `data` input, exposes an Artifact reference through `output`, and owns a non-empty `name` plus a `text`, `markdown`, or `json` artifact `type`.
- `worklite/artifact-query@1` accepts a required JSON `request` input and returns `{ request, candidates }` through `output`. Its immutable configuration selects a JSON Artifact `name`, a top-level string `titleField`, and one or more top-level string `descriptionFields`. It reads all matching Artifacts in the current workspace without filtering by Workflow or Run, including detached Artifacts. It skips records without a non-empty title or description, joins non-empty description fields with a space, and returns only `{ artifactId, title, description, createdAt }` per candidate, sorted by creation time descending and then Artifact ID descending. It never creates or modifies Artifacts or imposes a history limit. The caller's request is passed through without alteration.
- `typesafe/systemone-map@1` evaluates one typed question set against every element of an array inside its required JSON `state` input, in a single node invocation. Its immutable configuration contains the public Provider/model id, a typed `questions` object, a required `itemsPath` addressing the array, an optional `contextPath` addressing shared context, an optional positive `concurrency` bound, and an optional `rank`. Each element is evaluated against its own upstream request whose state is `{ item, context }`, so an element carries only its own content plus the shared context the author selected. The node preserves input order and exposes `results` as the evaluated elements with their typed `answers` merged in; an element that is not a JSON object is exposed under `item` beside its `answers`. For object state it retains the state's top-level fields and overlays `results` and `usage`, following the same pass-through rule as `typesafe/systemone@1`; primitive and array state is exposed under `state`. A configured `rank` orders `results` by a dot-delimited answer path, keeps only elements at or above `minimum`, and truncates to `limit`; ranking is deterministic server-side ordering applied after evaluation, never a model judgement. Per-element failures fail the node under its ordinary error policy. This is node-internal iteration, not port-level joining: the scheduler sees one invocation, one committed output, and one NodeRun.
- `typesafe/systemone@1` accepts required JSON-compatible `state` on its `state` input and returns the upstream System One response, including typed `answers`, through `output`. For object state it retains the original top-level fields; primitive and array state is exposed under `state`. Its immutable configuration contains the public Provider/model id and a typed `questions` object. It uses the internal Gateway forwarding path, keeps Provider credentials outside the WorkflowVersion, and can route answer fields through structured edge predicates.
- `worklite/dashboard` accepts `data`, exposes the committed upstream value through `output`, and carries the immutable Home board layout. The board format is generic and compositional: `layout.header`, `layout.main`, and `layout.footer` each contain ordered elements of kind `text`, `count`, `metric`, or `list`. A `text` element carries static text; a `count` element carries a label and resolves to the output item total; a `metric` element carries a label plus a field key and type and reads that key from an object output; a `list` element carries a `titleKey` and display `{ key, label, type }` fields with `text`, `number`, `boolean`, `datetime`, or `url` types, and its items are the output array or the single object output. A `url` field is not rendered as a table column: when an item's value for it is an `http(s)` string, the row navigates to that value. The committed output must be a JSON object or an array of JSON objects. Home renders the board directly on its card; the first list element is the card's paginated table content. Unknown fields are ignored, missing fields display explicit empty values, and non-object list items render as bounded raw JSON. Rendering is tolerant: contract mismatches never fail the board or the node.

Publication requires every `typesafe/systemone-map@1` node to contain a valid public model id, a non-empty `questions` object, and a non-empty `itemsPath`, and rejects a non-positive `concurrency`, a `rank` without a non-empty `path`, a non-positive `rank.limit`, and a non-numeric `rank.minimum`. Publication requires every Workflow Agent node to contain a valid public model id and to reference only Skills and MCP servers from the workspace. An Agent node that declares `outputContract` must set `outputFormat` to `json` and must supply a non-empty array of unique non-empty key names. Agent `context` is optional. It may receive one unbounded initial edge (an explicit Workflow Input edge must be unconditional) and one bounded feedback edge; when no unbounded incoming edge exists, the Agent uses the Workflow Run input for its initial invocation. A later bounded-loop traversal supplies its committed source output as the next context value. Context accepts arbitrary JSON-compatible values. Several conditional branches may converge on one `context` port because only the matching edge delivers a token. Merging two tokens into a single invocation is a distinct capability: port-level joining and concurrent branch scheduling require separate architecture decisions, and a single-value port that receives two tokens runs twice instead.

Graph definitions use `schemaVersion: 4`. The multi-port increment intentionally provides no schema-version adapter or migration for version 1 or version 2 definitions. Earlier drafts and published versions are not editable, publishable, or executable after the change. The personal workspace contains no Workflow records when this increment is introduced, so no persisted workflow data is rewritten.

### Editing and AI Assistance

The editor uses `@xyflow/react` with node dragging, edge creation and reconnection, panning, zooming, and fit-to-view. Users add nodes from a palette and configure node-owned fields directly through React-rendered nodes or the contextual inspector. The inspector remains the complete keyboard-accessible path for reviewing configuration and removing graph state. A side-panel AI assistant may modify the workflow from natural-language instructions. Before proposing a graph, Chat reads the current platform snapshot and chooses only the dynamically reported node capabilities and workspace resources. The assistant produces a logical Workflow Plan keyed by model-chosen node keys; it does not generate durable node IDs, canvas positions, or direct database state.

The server normalizes each logical plan into generated node identifiers, deterministic canvas positions, formal edges, and validated node configuration. It validates registered node types, configuration schemas, port existence and compatibility, structured edge conditions, bounded-cycle constraints, workspace Skill/MCP references, and graph constraints before converting the plan into the existing structured operations.

AI edits are validated structured operations: add, delete, update, or move a node; add or delete an edge; or update workflow settings. The AI cannot write arbitrary workflow state directly. The server validates and atomically applies operations.

Every manual or AI edit creates an `EditRevision` with its actor, optional source instruction, operations, resulting snapshot or snapshot reference, and timestamp. The initial strategy uses immutable snapshots and a current-revision pointer. This favors reliable undo, redo, refresh recovery, and cross-device recovery. Zustand may provide immediate local history, but server revisions are authoritative.

### Workflow Draft Persistence

Every Workflow owns one mutable `WorkflowDraft` and an immutable revision history. The draft stores the current revision pointer and the current graph `WorkflowDefinition`; each meaningful manual or AI edit is submitted as typed operations against a `baseRevisionId`. The API validates and applies the operations in one transaction, writes an immutable `EditRevision` snapshot, and advances the draft pointer. Textual form and canvas-position edits may be batched until blur, drag completion, or explicit save so a keystroke or pointer frame does not create a revision.

The persisted definition includes the schema version, an optional workflow-input example, workflow-level execution defaults, generic nodes with canvas layout, and explicit graph edges. The draft is the only mutable source for editor recovery; the browser may optimistically render it but does not own durable workflow state.

Workflow draft operations are exposed through `POST /workflows/:workflowId/draft/operations` with a required `baseRevisionId`. The response returns the authoritative draft, revision identifier, and undo/redo availability. `POST /workflows/:workflowId/draft/undo` and `POST /workflows/:workflowId/draft/redo` move the server-owned draft pointer without mutating immutable revision snapshots. A stale base revision is rejected so concurrent browser tabs or assistant edits cannot silently overwrite one another.

Workflow deletion is permanent. Deleting a Workflow removes its mutable draft, edit revisions, immutable published versions, schedule, run history, node runs, and run events in one workspace-scoped operation. Artifacts are retained and detached because their Workflow and Run references use `ON DELETE SET NULL`. There is no recycle bin, soft deletion, compatibility alias, or restoration path.

Workspace resource deletion follows one explicit lifecycle policy. There is no standalone Agent deletion flow: Chat runtime records are protected, while Workflow Agent configuration is deleted with its draft or immutable Workflow version. Skills and MCP servers may be deleted only when no Workflow draft or immutable version references the resource. Provider deletion remains owned by the Gateway. Artifact deletion permanently removes the Artifact record and its WorkLite-managed object when one exists. Runs, immutable Agent and Workflow versions, audit logs, and built-in Plugins are not independently deletable.

### Drafts and Published Versions

```text
WorkflowDraft --publish--> immutable WorkflowVersion --run--> WorkflowRun
```

Drafts can change. Published versions cannot. A publication copies the current draft definition into a new immutable WorkflowVersion with its source revision and locked Node Type/resource references. Every execution is tied to one immutable workflow version; draft workflows cannot be run directly. Publication rejects Workflow Agent nodes whose public model id is invalid or whose selected Skills or MCP servers do not belong to the workspace. The editor configures Workflow Agent nodes directly, disables Run while the draft has unsaved changes, and identifies that Run targets the latest published version.

The graph increment does not rewrite existing drafts or published versions. Version 1 definitions remain stored but are rejected by graph reads, publication, and execution. New drafts and publications use version 2 without a compatibility adapter.

### Human-Gated Browser Nodes

A trusted Workflow Node Type may suspend execution when an external browser operation requires a person. Suspension is a persisted runtime result, not a long-running in-memory promise. The Workflow Run and current Node Run enter `waiting_for_input`, retain the current node and all committed predecessor outputs, and reference one persisted pending action. Completing that action schedules the same Run for continuation from the suspended node. Cancelling the Run cancels its open action and active browser context.

Pending actions have a stable type, status, credential-safe display payload, expiry, and optional external-operation reference. The first action types are `wechat_login` and `wechat_publish_confirmation`. QR images and expiry metadata may be returned to the browser, but authenticated browser state, cookies, tokens, and private platform responses never are. An expired QR action remains recoverable: refreshing it replaces the display payload without rerunning successful predecessor nodes or creating a duplicate external draft.

The built-in `wechat-official-account` Plugin owns WeChat Official Account connection state, Playwright browser contexts, session health checks, and publication records. It is separate from the `codex-cli-chat` execution plugin and `feishu-bot` messaging transport. Version 1 remains immutable and accepts a Markdown `article` input plus optional publication `metadata`. Version 2 accepts required Markdown `article` and Workflow image `coverImage` inputs plus optional publication `metadata`, references one configured official account, and returns a publication reference. Version 2 waits for a generated PNG cover, uploads it through the real MP cover picker, and creates no Artifact. A Workflow may fan out the same Agent output to an Artifact node and the publication node. Existing version-1 published graphs retain their original node behavior; newly created editor and seed nodes use version 2.

WeChat administration uses a dedicated Playwright session owned by the deployment profile. Authentication state is stored through the server secret-storage boundary and is never returned to Web. Browser automation uses the real `mp.weixin.qq.com` user interface for login, article editing, media upload, draft creation, publish initiation, and confirmation. Undocumented private HTTP request shapes are not a WorkLite contract. The API serializes operations per official account and uses the Workflow Run plus node identifier as the publication idempotency key. A resumed or retried node reopens its existing draft or returns its existing published result rather than creating or sending another article. A publication record that already holds a platform draft identifier therefore reopens that draft even when its own status is `failed`, so retrying a node that failed after the draft was saved cannot leave a second draft in the official account.

The initial node supports `draft` and `publish` modes. Draft mode succeeds after the platform confirms that the draft was saved. Publish mode suspends whenever login or final publish confirmation requires a QR scan and succeeds only after the platform confirms publication. Timer and publish mode may not coexist in the same Workflow version in the initial increment; scheduled draft creation remains supported.

Draft creation classifies the platform's draft-save response as accepted or rejected before deriving any failure text from it, because a success response carries both a zero status code and an `ok` message. An accepted save resolves its draft identifier from the response body or, when the body omits it, from the editor URL's `appmsgid` parameter, which the platform sets once the draft exists. A rejected save fails immediately with that response's own credential-safe status text rather than waiting out the draft-identifier timeout.

A draft-mode failure is otherwise reported with the platform's own reason when the browser session exposes one. Blocking editor dialogs other than the known content-structure warning are reported as the dialog's own text. An accepted save whose identifier never appears in either the response or the URL is reported as an exposed-identifier failure, distinct from a platform rejection, so the two conditions remain separable in remote diagnosis.

## Workflow Automation and Home

WorkLite has two primary product services: Workflow automation and Home. Workflows acquire, process, and produce data. Home displays only boards published by Dashboard nodes and owns no global Workflow data source or platform widgets. Source-specific integrations such as Meegle are Workflow use cases rather than standalone products, API domains, routes, or navigation destinations.

A Workflow's fixed-interval scheduling source of truth is its versioned `worklite/timer` node, not an independently editable schedule resource. Draft Timer changes do not affect active scheduling until Publish. Publishing a version with a Timer synchronizes the internal `workflow_schedules` runtime projection to that immutable WorkflowVersion; an enabled Timer schedules future runs, a disabled Timer retains disabled runtime status without future runs, and a version without a Timer removes the projection. The read-only `GET /workflows/:workflowId/schedule` endpoint exposes the active bound version, next-run time, and last-run status for the Timer inspector. There is no schedule mutation endpoint. Scheduled executions are ordinary Workflow Runs, cannot overlap for the same Workflow, and a paused scheduled Run remains the active overlap guard until resumed or cancelled; an overdue schedule advances by running once after restart. Cron expressions, calendars, webhook triggers, catch-up replay, and compatibility routes for removed schedule APIs are intentionally omitted.

A workflow may invoke an embedded Workflow Agent node configured with instructions, a public model id, Skills, and MCP server access. Skill and MCP capabilities serve Agent execution. Plugins and Agents remain peer-level workspace capabilities: a Plugin may register runtime capabilities or Node Types, while an Agent performs model-driven work and may consume Skills and MCP servers. Workflow composes these capabilities without making a source-specific integration a first-class product surface.

A Workflow becomes eligible for Home only when its latest published version contains its single `worklite/dashboard` node. Home boards are self-contained cards with no separate board detail view; the Dashboard node owns only the layout, and its header region renders in the card title area. Draft Dashboard changes do not affect Home until Publish. Home does not own a global Workflow data source, dashboard dataset projection, or persisted Workflow-output snapshot. It discovers eligible boards from immutable WorkflowVersion definitions and reads the Dashboard node's committed output from the Workflow's latest successful Run of that published version through the normal Run contract. There are no platform-defined Workflow boards, Dashboard-level scheduling controls, or Run now controls. A Workflow without a published Dashboard node, and a Run without a successful Dashboard node output, is not eligible for Home display. Permanent Workflow deletion removes its versions and run history, so its Home board is removed automatically.

Eligible Dashboard-node boards are displayed by default in a built-in uncategorized presentation, not stored as a category record. The user may create, rename, and delete Home board categories and assign a board to at most one category. These organization references are database-backed workspace metadata; they never persist Workflow output, alter board eligibility, or create a global Workflow data source. Removing an assignment returns the board to Uncategorized, deleting a category returns its boards to Uncategorized, and deleting a Workflow removes its assignment.

## Runtime Architecture

Runs are asynchronous because they may take minutes or longer. The initial local runtime schedules execution in the API process so HTTP requests return immediately:

```text
Create run
  -> persist WorkflowRun and scheduler state
  -> schedule in-process job
  -> validate edge conditions and bounded-cycle constraints
  -> dequeue one ready node invocation
  -> resolve and execute it through the Node Type registry
  -> evaluate outgoing edges and enqueue newly ready invocations
  -> persist scheduler state, NodeRun, and events
  -> publish progress
  -> persist final output or failure when the queue is empty
```

The API returns a `runId` immediately. The browser loads run state through the API and subscribes to Server-Sent Events. Reconnecting with the same `runId` restores current state and continues event delivery. Because the local executor has no durable lease for active model or command work, database startup changes persisted `queued` and `running` Workflow Runs and Node Runs to `failed` with a stable restart explanation. Persisted `waiting_for_input` Runs remain suspended. Their browser action is marked expired on restart and can be refreshed before the Run continues.

```text
queued -> running -> succeeded
                  -> waiting_for_input -> running
                  -> paused -> queued
                  -> failed
                  -> cancelled -> queued
                  -> timed_out
```

A `WorkflowRun` stores its workspace, workflow version, input, current node, timestamps, final result, status, and internal scheduler state. A `NodeRun` stores one node invocation's Node Type identity, mapped input, committed output or Artifact references, status, duration, retry count, and plugin-specific execution references. Repeated loop invocations therefore produce separate NodeRun rows for the same workflow node identifier. Run progress uses generic node lifecycle events; plugin-specific events are namespaced and carry immutable data snapshots. The detailed Run contract exposes ordered Node Runs as execution logs, including their status, timing, retry count, mapped input, committed output, streamed model output, activity timeline, and credential-safe failure reason. Replayable `node.activity` events describe Agent setup, model rounds, Skill script execution, and MCP tool calls without creating a second activity table. Agent model requests carry opaque Workflow Run and Node Run correlation metadata so a Run detail can link its node activity to the matching Gateway Provider request logs. Image payloads are the exception to mapped-input/output logging: scheduler state retains full generated-image JSON until downstream consumption and possible authentication resume, while NodeRun input/output records, lifecycle event payloads, terminal Run results, and Run detail views retain only the image summary. Publication records never retain generated-image bytes. It also reports whether the immutable WorkflowVersion contains an Artifact node so clients omit Artifact presentation entirely for versions that cannot produce Artifacts while retaining an empty Artifact state for eligible versions that produced none. The Run reports a server-owned `resumable` flag, and each Node Run additionally reports whether it is the retryable failed invocation, so clients never derive either recovery eligibility from internal scheduler state.

A `node.activity` event carries a namespaced `phase` describing one step inside a single Node Run: node setup with its resolved Node Type, configuration, error policy, and mapped input per port; each execution attempt, distinguishing an automatic `retry` error-policy attempt from the first; every Agent model round with its model, round index, finish reason, and dropped context count; each Skill script invocation with its Skill id, script path, arguments, and the `command_executions` identifier that owns its streamed output; each MCP tool call with its server, tool, arguments, and result; and the outgoing edge decision with the evaluated condition and traversal count for every edge selected or rejected after the node committed. Skill script stdout and stderr are not copied into activity payloads because `command_execution_events` already owns them; activity references that execution instead. Activity payloads pass through the same image-summary rule as mapped input and output, so generated image bytes never enter an event.

Activity is durable and replayable through the existing run event sequence, so a client that reconnects with `Last-Event-ID` reconstructs a complete timeline without a second activity table or a separate transport. Because activity multiplies the event count for one Run, clients apply activity events incrementally and must not refetch the whole Run detail per event. Run events are retained for the life of their Run and are removed only when the Run is removed; activity is not independently truncated, and no separate activity retention window is introduced by this increment.

Runtime requirements include node and workflow timeouts, cooperative cancellation, worker heartbeats or leases, persisted intermediate results, classified transient retries, idempotency for retryable external side effects, and per-workspace concurrency, duration, and model-usage quotas.

Completed and suspended node runs are retained. The API-local executor resolves registered node types and persists each node transition. For an Artifact node, the Artifact row, successful NodeRun output and Artifact reference, and advanced scheduler state commit in one SQLite transaction; the replayable `artifact.created` event is published only after that transaction succeeds. A failed transaction leaves no Artifact and preserves the active invocation for the normal failed-node retry path. Continuation reloads the persisted scheduler state and re-enters only the suspended invocation. A pre-scheduler Run that already contains Node Runs but has no scheduler state fails explicitly instead of reconstructing tokens or rerunning predecessors; no compatibility adapter or in-flight Run migration is provided. Conditional branches and loop iterations execute sequentially; concurrent branch execution remains deferred. A durable queue such as BullMQ remains a later boundary for multi-instance execution, concurrent branches, or stronger leasing; the single-process runtime uses SQLite-backed suspension and continuation for human-gated nodes.

A queued or running Run may be paused without a mid-invocation checkpoint. Pause transactionally marks the Run `paused`, moves a running active Node Run back to `queued`, preserves scheduler state, current node, and completed predecessor invocations, and aborts the in-memory request. Resume accepts a paused Run or a cancelled Run that still has persisted scheduler state, transactionally returns the Run to `queued`, moves its interrupted active Node Run back to `queued`, and re-enters the existing scheduler. The interrupted active invocation reruns from its beginning, while completed predecessors, committed outputs, edge traversal counts, and Artifacts never rerun. A cancelled Run without persisted scheduler state is not resumable and is not reconstructed. `waiting_for_input` already provides durable human-gated suspension and cannot be paused. A paused Run is active but reversible execution state: it remains observable on Run SSE, survives restart, accepts cancellation, and prevents overlapping scheduled execution until it leaves `paused`; schedule recovery preserves the paused Run's existing schedule claim. Continuing a cancelled Run preserves the cancellation and subsequent continuation as Run evidence; node-level idempotency records, including an existing WeChat draft identifier, remain authoritative during re-entry.

A failed Run may be retried from its failed node. Node failure preserves the persisted scheduler state, including the active invocation's NodeRun identifier, ordered position, and mapped input, so retry re-enters that same invocation with every committed predecessor output intact. Retry never reruns a successful predecessor, never creates a duplicate NodeRun row, and never advances the ready queue or edge traversal counts on its own. It is accepted only when the Run is `failed` and the requested NodeRun is the persisted active invocation; any other NodeRun, a Run in another status, and a Run without persisted scheduler state are rejected. An accepted retry returns that NodeRun to `queued`, clears its previous failure text and finish time, increments its retry count, and returns the Run to `queued` so the normal executor continues from the same node. Node-level retry is a manual recovery command and is independent of the per-node `retry` error policy, which still governs automatic in-run attempts. Retrying an earlier successful node would require rolling back committed input tokens, edge traversal counts, and downstream Artifacts, and remains deferred.

Initial run endpoints are:

```text
POST /workflow-versions/:workflowVersionId/runs
GET  /runs/:runId
GET  /runs/:runId/events
POST /runs/:runId/cancel
POST /runs/:runId/pause
POST /runs/:runId/resume
POST /runs/:runId/pending-action/refresh
POST /runs/:runId/nodes/:nodeRunId/retry
```

The detailed Run contract is read at two depths through the same routes. The Workflow List Run records dialog remains the in-context overview and discloses each Node Run's mapped input, committed output, and activity timeline in place. `/runs/:runId` is additionally a routable web destination for deep log reading, reached from that dialog and from a Run reference elsewhere in the product. Both surfaces read the same Run detail and the same replayable event stream; the route adds reading room, not a second contract, and Run records remain reachable without it.

The workflow-level run endpoint is intentionally not part of the persisted-version contract; callers must select an explicit immutable workflow version.

Production uses a same-origin `/api` route through the reverse proxy to simplify CORS and Server-Sent Events delivery.

## Agent Team Implementation Direction

On 2026-10-03, the user confirmed the combined BMAD + TEA and LangGraph.js direction and authorized implementation. [Agent Team Implementation Plan](agent-team-implementation.md) records the approved contracts, milestones, and acceptance scenarios. Internal persistence, execution, checkpoints, effect journaling, project-context capture, managed run output, Team configuration, Run creation/control, persisted Run events, operation recovery, and their public REST/SSE routes are implemented. Chat, `worklite-platform`, typed contracts, snapshot metadata, and reference protections are synchronized in the same boundary. Team creation and deletion remain outside the first built-in-template scope. The API increment introduced no Web routes; the separately designed Web increment now owns the direct Team and Team Run interfaces.

BMAD supplies development process content and role responsibilities. TEA supplies testing strategy, automation, and evidence traceability. LangGraph.js supplies Team execution ordering, checkpoints, and human-input suspension. WorkLite owns the product APIs, configuration snapshots, execution records, project context, Commands, Skill and MCP execution, model transport, and user interaction. Process content must be pinned and packaged with its required reference files; upstream skill commands are not treated as shell executables.

The Test Author role uses the pinned TEA `bmad-testarch-automate` workflow. Its `SKILL.md` resolves sibling instructions, checklist, step files, workflow metadata, templates, and knowledge from its own workflow root, so WorkLite packages that complete directory as the direct reference closure rather than redirecting references to the Test Designer workflow. Test Runner remains backed by WorkLite Commands and has no upstream TEA entry point.

The Team capability has an independent TeamRun boundary, with role configuration embedded in an immutable TeamVersion. It does not restore standalone user-managed Agent resources. Each TeamRun has exactly one LangGraph execution thread. Existing Workflow Runs continue to use their deterministic Workflow scheduler; a TeamRun is never advanced by both schedulers. This adds a second orchestration dependency and its maintenance cost, while preserving the existing Workflow graph and historical Run contracts without a compatibility adapter.

The initial implementation targets one development-team process with planning, test design, optional implementation and test authoring, actual test execution, and independent review. Planning and review may execute independently where dependencies permit; writes to the same checkout execute sequentially. Team documents belong to TeamRun records in the initial scope, so the existing Workflow Artifact-production and Home Dashboard-eligibility rules remain applicable to their current resources.

The developer role, including implementation repair tasks, runs through the shared project-executor boundary described for Chat: Codex App Server or Claude Code. The developer role configuration selects its `executor`, defaulting to `claude`, and each new TeamVersion captures that executor's launch and parsed executable arguments; changing the plugin command or role configuration cannot change an accepted Run. Planning, test design, test authoring, test execution and independent review retain the AI SDK-backed model loop. WorkLite keeps Team intake, LangGraph orchestration, immutable versions, project instructions, non-developer role authorization, evidence and recovery. Older snapshots without a captured executor cannot execute developer tasks and are not migrated or silently routed to another engine.

The developer executor runs in the real checkout with its own native tools, under the operator's local configuration and without approvals, exactly like a Chat project task. Pinned process references for the role are materialized into a task-scoped temporary directory whose paths are listed in the task prompt, because the executor has no WorkLite `process_reference` tool. The role's captured Skills and MCP servers are handed over natively. The developer returns the existing Team JSON result; a user question is returned through the existing structured task result and pending-input boundary. Team events record the executor process Command, session or thread identifiers and the executor's own activity, and the task result records changed files and that Command reference. Codex follows the [App Server protocol](https://github.com/openai/codex/tree/rust-v0.157.1/codex-rs/app-server-protocol) and requires 0.157.1 or later; Claude Code follows the stream-json control protocol and requires 2.1.259 or later.

Because developer effects happen natively, they are not recorded in the Team operation journal and have no uncertain-operation recovery. Cancellation interrupts the executor and stops its process; an interrupted developer attempt fails, and a new attempt reconstructs context from Team evidence and the checkout's actual state rather than resuming an opaque executor session. The operation journal, uncertain-operation recovery and exact-command grants remain in force for the other roles' WorkLite tools.

A Codex developer sends the captured role public model to the current WorkLite Gateway through the `~/.codex-cli` Responses Provider; the model must be an `openai/responses` or `codex/responses` public id, and Provider protocols are never changed. A Claude Code developer sends its role public model, which must be an `anthropic/messages` public id, to the Gateway named by its effective `ANTHROPIC_BASE_URL`. Commands owns the executor process, bidirectional stdin, uncapped output evidence and process-group cancellation. Run reads include the captured developer executor and persisted `task.activity` events, so Chat can inspect them through its existing Run tool after reconnect.

Checkpoints restore control flow while command and tool-attempt records prevent recovery from blindly repeating completed effects. Project instructions and already-granted authorization determine whether a role may write files, generate tests, execute particular checks, or manage services. This increment adds no Web configuration controls, new Team scheduler, compatibility adapter, service replacement or automatic verification.

Command execution for non-Codex Team roles is authorized by exact command strings, not by prose in a prompt. The Codex developer executor is excluded from this grant check and directly executes its captured task. A TeamRun persists a cumulative grant set; run creation may seed it, and a pending-input answer may grant one or more additional exact commands only through a structured response field. The natural-language answer itself never grants non-Codex command execution. The runtime carries the grant set through LangGraph state into each task, and the `bash` tool input must equal a persisted command exactly after input trimming before Commands reserves or creates an execution. Mode text, role instructions, model output, and recovery replay cannot enlarge the set. A plan-only run has an empty grant set. In this first boundary, executable Skill scripts are not exposed to Team roles because their generated temporary invocation command cannot be represented truthfully as a user-authorized exact command; captured Skill instructions remain available.

An operation whose effect is uncertain settles the active task attempt in a distinct `waiting_for_recovery` projection and exposes one durable operation-recovery input keyed by the stable operation identity. The structured decision is one of: adopt the terminal Command record already linked to the operation, mark the operation failed without replay, or create one explicitly authorized replay operation. Adopting a Command reads its authoritative status and output and never dispatches again; a queued, running, cancelling, or cancelled Command remains recoverable. A replay is a new operation row beneath the same logical task and semantic input, preserves the original uncertain record, and still requires the exact-command grant for `bash`. No restart, retry, pause, resume, or prose answer implicitly replays an uncertain effect. A cancellation request may abort the work that makes an effect uncertain, but it cannot cancel that recovery input or terminalize the Run first; the structured recovery decision settles the effect and supersedes the pending cancellation request when it selects adoption or replay.

The Team owns one durable conversation for the built-in Team. A structured `@Coordinator` mention starts a task request; replies answer the current Coordinator question without another mention. Coordinator intake is deterministic server-side parsing: the submitted text supplies the goal, wording may resolve `plan_only`, `validate_existing`, or `implement_and_validate`, and an absolute directory on the API host must be explicit or recoverable from the Team's latest still-valid remembered selection. A still-valid remembered directory is reapplied silently. Missing values are collected one at a time. Once goal, directory, and mode are known, the server creates the existing Team Run automatically; there is no second Start control. Chat prose never grants commands. One active task is the initial scope regardless of whether the active Run originated in the conversation or the direct Run API: later Coordinator mentions remain visible as queued requests until that Run settles, then complete queued intake resumes automatically. Ordinary messages during active work do not mutate Run scope.

Conversation state is persisted by the API. It records the Team conversation and its latest valid project directory, one intake per stable client submission id, ordered conversation messages, and replayable conversation events. Sending uses the submission id idempotently so a reconnect or duplicate send cannot create a second Run. Conversation events are persisted before publication, replay in sequence after the browser-supplied `Last-Event-ID`, and are then followed by live delivery. Existing Team Run answer, recovery, pause, resume, cancel, and retry APIs remain authoritative. Conversation messages project concise Run state, member questions, and file delivery; they are not a second scheduler or evidence journal. Raw model deltas, task JSON, command output, and document bodies remain on the Run detail surface. Direct-origin Run answers remain immutable Run evidence and are not projected retroactively into the Team transcript. Chat may inspect and continue existing Team Runs and dispatch a new request through the shared conversation dispatch boundary. Dispatch enters Team conversation intake with a stable submission id and never bypasses its missing-field questions, active-Run queue, immutable version capture, or exact-command authorization.

A Team document has two distinct boundaries. `document.committed` remains immutable evidence that the document row was committed in the Team Run transaction. `document.delivered` is published only after its managed file is materialized successfully, and `document.delivery_failed` reports a materialization failure without treating the producing role as failed or rerunning it merely to recreate the same immutable document. The document detail and download routes retry materialization for a not-yet-delivered immutable document before serving it; a failed download therefore does not require rerunning the producing role. Conversation file messages consume only `document.delivered`, display the server-derived filename, and open the immutable revision in a contextual viewer with download. Team documents remain Team Run documents; they are not Workflow Artifacts and do not change Home eligibility.

The public Team conversation boundary is `GET /agent-teams/:teamId/conversation`, `POST /agent-teams/:teamId/conversation/messages`, `GET /agent-teams/:teamId/conversation/events`, `GET /agent-team-documents/:documentId`, and `GET /agent-team-documents/:documentId/download`. The Team page and Run page are direct routes for the one built-in Team. The existing Web Team starter navigates to the Team page; master dialogue can dispatch Team requests through the protected platform script and shared server boundary. Explicit Web Workflow mentions also use that boundary. Team configuration is mutable, every Run captures an immutable TeamVersion, and Team creation/deletion remain unavailable. The API boundary updates Chat guidance, the complete `worklite-platform` Skill package, typed contracts, workspace snapshot capability metadata, resource reference protections, and applicable repository conventions together. The platform snapshot advertises only implemented Team operations. Page behavior is owned by `ui-ux-design/`; the implementation plan does not establish a parallel page-specification directory.

## Real API Integration Increment

The first production-facing API increment replaces browser-only mock data with a same-origin REST API backed by SQLite. The web application uses one typed API client and TanStack Query for remote state; resource pages do not import mock domain records at runtime.

The initial vertical slice includes:

- singleton workspace loading without an account or sign-in flow;
- workspace-owned Agent and Workflow reads and writes;
- asynchronous Workflow Run creation and status reads through the API-local executor;
- shared request and response contracts in `packages/contracts`.

Drizzle owns the SQLite schema. Checked-in, ordered Drizzle SQL migrations are applied by the Drizzle migrator during database initialization before runtime bootstrap and restart normalization. API controllers remain thin and delegate persistence to module services. The API schedules run execution in-process and persists run state transitions. Startup creates the singleton personal workspace, the protected Chat, and protected built-in Skills; all other resource records are user-created.

This increment intentionally does not add compatibility routes for the previous mock-only behavior or account-based identity integration.

## Real API Resource Completion Increment

The second API increment extends the same typed, same-origin boundary to the remaining workspace resources: Skills, MCP Servers, Model Providers, Artifacts, Usage, and Audit Logs. These resources remain workspace-owned and are queried through TanStack Query; browser pages no longer import mock records at runtime. The local persistence target is SQLite.

MCP credentials and Provider custom-header values are write-only inputs. The Provider API key is the single readable secret: WorkLite is a single-user local installation, so Gateway Provider administration responses return the stored key and the browser edit form prefills it. Every other API response exposes connection state, masked metadata, protocol, endpoint metadata, allowed tool names, model catalogs, and header names, but never secret values. The workspace platform snapshot, Skill scripts, Agent tool-call arguments, ordinary logs, and errors continue to exclude Provider credentials and custom-header values. Provider headers must be a JSON object with string keys and values; omitted headers preserve the stored value during an update, while an explicit empty object clears them. Skill and artifact content is treated as untrusted data. The local implementation stores textual artifact content and skill metadata in SQLite; binary archive processing and large-payload storage remain deferred. Audit events are append-only records written by resource services. Usage is a read model derived from persisted runs for the initial increment. Provider connection observability is owned by the Gateway request-log surface described in the Provider Proxy increment; the API does not maintain a separate diagnostic-log resource.

This increment does not add third-party identity-provider integration, arbitrary MCP `stdio` execution, binary archive processing, or compatibility aliases for mock routes.

## Provider Proxy Increment

The Provider Proxy increment adds a Portkey Gateway sidecar behind the existing NestJS API. Portkey Gateway becomes the Provider system of record and exposes a local administration API for Provider CRUD, model discovery, and connection tests. It uses an independent SQLite database file and owns the `gateway_providers` table; the API SQLite database is not used for Gateway Provider runtime or administration state. WorkLite retains a hidden protected `gateway-provider` binding and proxies user configuration to the Gateway without independently persisting Provider credentials. Gateway startup never imports legacy Provider JSON or API database rows. Provider records for a deployment are created through the Gateway administration API or an explicit provisioning script. Each Gateway Provider stores a user-supplied `baseURL` and a protocol value in the `openai/chat`, `openai/responses`, `anthropic/messages`, `codex/responses`, or `typesafe/systemone` form. The API exposes one unified Gateway base URL with OpenAI-compatible and Claude Messages routes and forwards namespaced models through Portkey, where the Gateway resolves the stored Provider configuration.

The sidecar is an API-owned runtime managed by the `portkey-gateway` module. It binds to the configured loopback port; process status, readiness, PID, and failure details remain in memory and reflect the current API process. The module exposes read-only status and Gateway Provider administration routes; lifecycle mutation routes are intentionally absent. API startup starts the sidecar, unexpected exits trigger an automatic restart, and proxy requests wait for readiness before forwarding. If the sidecar remains unavailable, ordinary proxy and model-runtime requests fail with a classified gateway-unavailable response.

This increment intentionally does not add proxy authentication, fallback policy, multi-provider routing, prompt/response persistence, or compatibility routes for `local-llm-proxy`. Credential-safe request statistics are retained only as described in the Model Gateway boundary. The local Portkey source is pinned to a known revision and receives only the WorkLite-specific model-discovery, request-routing, and statistics patches; upstream synchronization remains an operator-maintained dependency update.

### Gateway-Native Codex Provider Increment

The Codex transport is a Gateway-native `codex/responses` Provider adapter. It runs in the existing Portkey Gateway process and exposes the same unified `GET /v1/models`, `POST /v1/responses`, and `POST /v1/responses/compact` Gateway entry points; no separate Codex listener or API-owned Codex process is required.

The adapter uses a Gateway-owned Codex authentication manager. It supports the Codex CLI-compatible OAuth PKCE flow with a short-lived in-memory login session (`state` and `code_verifier`), the fixed registered callback `http://localhost:1455/auth/callback`, and the `offline_access` scope needed to obtain a refresh token. The manager persists one local Codex credential record in the Gateway SQLite database, including refresh token, current access token, expiry, and account metadata. This single-user local installation does not require a separate encryption-key configuration; authentication routes return status and masked metadata only. The existing `CODEX_ACCESS_TOKEN` environment variable remains an explicit bootstrap fallback when no persisted credential is available.

Before a request uses a Codex credential, the manager refreshes it when it is within a five-minute pre-expiry window. Refreshes are serialized per credential, use bounded retry with backoff, and publish the new token atomically so concurrent requests cannot consume the same rotating refresh token. A Codex upstream 401 triggers one forced refresh and retry. Logout clears the local persisted credential and runtime cache. The Gateway exposes login start, callback, status, refresh, and logout control routes through the existing API boundary. Tokens never reach WorkLite API responses or the browser.

The adapter forwards the Responses request body and stream to the private Codex endpoint with the required Codex client headers and normalizes the private model catalog into an OpenAI model list. A Codex Provider uses the explicit `codex/responses` protocol; its configured `baseURL` is retained as Provider metadata and does not override the private Codex upstream URL. Codex Responses remains stream-first. The Gateway selects credentials from its enabled Codex account pool with priority-aware round-robin scheduling and per-account concurrency. Chat Completions translation, non-streaming assembly, weighted rate-multiplier routing, and WebSocket transport remain deferred capabilities.

Existing Providers configured as `openai/responses` against the former `apps/codex-proxy` loopback URL are not compatibility aliases; they must be changed to `codex/responses`. Remote deployments must provide a secure path for the fixed localhost callback, such as an SSH tunnel to port 1455; arbitrary public redirect URIs are not assumed.

## Repository Structure

```text
worklite/
|-- apps/
|   |-- web/                         # React and Vite SPA
|   |   `-- src/
|   |       |-- components/
|   |       |-- features/
|   |       |   |-- skills/
|   |       |   |-- mcp-servers/
|   |       |   |-- workflows/editor/
|   |       |   |-- runs/
|   |       |   `-- artifacts/
|   |       |-- routes/              # TanStack Router file routes
|   |       |-- api/
|   |       |-- hooks/
|   |       |-- lib/
|   |       |-- stores/
|   |       `-- styles/
|   |-- api/                          # NestJS HTTP API
|   |   `-- src/
|   |       |-- common/
|   |       |-- config/
|   |       |-- infrastructure/
|   |       `-- modules/
|   |           |-- agents/
|   |           |-- commands/
|   |           |-- skills/
|   |           |-- mcp-servers/
|   |           |-- workflows/
|   |           |-- workflow-revisions/
|   |           |-- runs/
|   |           |-- artifacts/
|   |           |-- model-providers/
|   |           |-- portkey-gateway/
|   |           |-- usage/
|   |           `-- audit-logs/
|-- packages/
|   |-- contracts/                    # Shared API and event contracts
|   |-- db/                           # Drizzle schemas and migrations
|   |-- workflow-engine/              # Framework-independent workflow logic
|   |-- agent-runtime/                # Agent execution and tool orchestration
|   |-- model-gateway/                # Model-provider abstraction
|   |-- mcp-client/                   # MCP discovery and execution
|   |-- skill-sdk/                    # Skill parsing and validation
|   |-- ui/                           # Shared browser UI components
|   |-- observability/                # Logging, tracing, and metrics
|   `-- config/                       # Shared tool configuration
|-- infra/
|   |-- docker/
|   |-- nginx/
|   `-- compose.yaml
|-- docs/
|   `-- project-architecture/
|       `-- README.md
|-- scripts/
|-- AGENTS.md
|-- AGENTS_WORKFLOW.md
|-- package.json
|-- pnpm-workspace.yaml
|-- turbo.json
`-- tsconfig.base.json
```

The recommended MVP creates only packages with active ownership boundaries:

```text
apps/web
apps/api
packages/contracts
packages/db
packages/workflow-engine
packages/agent-runtime
packages/model-gateway
packages/ui
packages/config
```

The MCP client, skill SDK, and observability code may begin inside applications or the runtime and move to dedicated packages when their boundaries stabilize. The model gateway is a dedicated MVP boundary because every Agent Runtime provider must use the same workspace, secret, usage, and error contracts.

## Deferred Capabilities

- Port-level joining that merges several tokens into one invocation, including dynamic joins over an unknown number of runtime branches. Converging edges are permitted; each delivered token still produces its own invocation. A Node Type that iterates over an array inside one committed input, such as `typesafe/systemone-map@1`, is not a join: it consumes one token, runs inside one invocation, and commits one output.
- Concurrent branch execution in Workflow Runs.
- Dynamic script-authored workflow orchestration as the primary Workflow model.
- A third-party plugin marketplace or untrusted plugin execution.
- Arbitrary user-supplied MCP `stdio` processes.
- Resume from an arbitrary failed node.
- Temporal or another replacement runtime for Workflow Runs. The separate planned Agent Team capability uses the confirmed LangGraph.js direction above.
- Multi-installation tenancy.
- Binary Skill assets, archive upload, package validation, and immutable Skill publication.
- Codex multi-account rotation, quota scheduling, Chat Completions translation, and WebSocket transport.

Adding a deferred capability requires an approved architecture change.

### Portable Workflow JSON

Workflows support a versioned portable JSON envelope for moving editable definitions between WorkLite workspaces. Export reads the current draft and emits `format: "worklite.workflow"`, `version: 1`, the workflow name, and its graph definition. Database identifiers, workspace identifiers, run history, schedules, credentials, and secrets are excluded. Workflow Agent public model ids and system prompts remain embedded. Skill and MCP server identifiers in Agent node configuration are replaced by workspace-portable references using resource names. Import resolves those names in the current workspace, rejects missing references, creates a draft, and never publishes or enables schedules.

Import validates the envelope, structured edge conditions, and bounded-cycle constraints, resolves every Skill and MCP server reference against the destination workspace, and creates a new mutable draft. Missing or ambiguous references reject the entire import. Import never overwrites an existing workflow, publishes a version, or enables a schedule.

## Changelog

### 2026-10-09 — Claude Code project executor and native executor tools

- Added Claude Code as a second project executor beside Codex for Chat project tasks and the Team developer role. Chat's `codex` tool became the executor-neutral `project_task` tool with an optional `executor`; Chat configuration and the developer role select a default, initially `claude`. Every new task and TeamVersion captures its executor launch.
- Executors now use their own native tools in the real project directory under the operator's complete local configuration and without approvals. WorkLite no longer provides Codex dynamic tools or disables native environments, and keeps no operation journal or uncertain-operation recovery for executor effects; it records the executor's event stream instead and fails interrupted tasks without replay. Selected Skills and MCP servers are passed in each executor's native form without putting credentials in arguments.
- Removed the native `cxo` Codex launch form; Codex always uses `~/.codex-cli` and the WorkLite Gateway. Claude Code must also reach the Gateway, and both executors' models must be Gateway public ids on a matching Provider protocol.
- Tasks, Runs and snapshots captured earlier, including `cxo` launches and tasks waiting for operation recovery, are not migrated; they remain readable and require a new task or Run.

### 2026-10-09 — Typed Chat platform tools

- Replaced the Chat model's generic `skill_script` selector for `worklite-platform` with one typed tool per script, generated from the package's `scripts/tools.json` manifest. Persisted deployment evidence showed 82 of 180 platform calls failing, about 90% from guessed field names or argument encoding, because the input contracts lived in `references/contracts.md`, which Chat cannot read.
- Kept execution, persistence, Commands, transcript presentation and the per-turn capability snapshot unchanged: a typed call is stored as a `skill_script` call with its model-facing tool name. Failed platform calls return the declared input schema with the error.
- Unified platform scripts on one JSON object argument, folded the unreachable contract and troubleshooting references into tool descriptions and a shortened `SKILL.md`, and removed both reference files.
- Existing conversations are not migrated. Their history still contains generic `skill_script` calls; a provider that rejects historical calls to a tool no longer offered requires a new conversation.

### 2026-10-09 — Deployment-backed development data

- Changed local development to a Web-only Vite process on port `3390` that proxies `/api` to the managed deployment API on `23391` and uses deployment-owned `.data/deployment/` state.
- Removed the separate development API, Gateway, SQLite, Gateway registry, Agent Team checkpoint, log, and PID paths; development no longer creates or maintains data outside `.data/deployment/`.
- Intentionally did not migrate or merge the retired development data into deployment state, and did not add a compatibility development backend.

### 2026-10-08 — Managed operator deployment and bounded Chat evidence

- Route `pnpm deploy:local` through the managed runner so a first deployment establishes its baseline and later invocations use isolated preflight, active-work cancellation, immediate process replacement, and matched rollback without task resumption. First migration stops only the verified legacy launcher process group after isolated preflight; unknown listeners remain untouched.
- Keep Codex task summaries bounded, load one operation result on demand, cap Skill-script output sent back to Chat, and return only the latest persisted snapshot plus other events from conversation records. Codex parsing repairs raw control characters inside JSON strings and preserves invalid output for inspection.

### 2026-10-08 — Chat-requested redeployment

- An explicit redeploy request in Web or Feishu Chat authorizes deployment of the current project snapshot through the independent managed runner, without a second confirmation action.
- Bind authorization to the persisted user message and immutable release, deduplicate repeated invocations within that turn, and observe progress in the original conversation. Keep profile isolation, managed-baseline ownership, preflight, interruption policy and matched program/data recovery.
- Remove the former Feishu upgrade-confirmation callback without compatibility handling; proposals alone remain non-executing.

### 2026-10-08 — Chat orchestration boundary and stable event observation

- Remove direct Chat host tools and custom Skill/MCP execution. Coding, project investigation and local commands use the conversation-owned Codex executor; collaboration uses Team intake and automation uses published Workflows. Retain historical evidence and explicit recovery without replay.
- Initial Agent SSE connections replay the latest persisted snapshot and its following events; reconnects retain Last-Event-ID replay. Web keeps one connection across running/waiting transitions and does not replace current content with older snapshots.

### 2026-10-08 — Deployment version increments

- Increment the public Web patch version on every local deployment invocation before compilation, reusing the existing version label and preserving isolated preflight before service replacement. The first authorized invocation advanced 0.1.0 to 0.1.1 and passed builds, isolated preflight and deployment readiness.

### 2026-10-08 — Chat Cancel and shared direct Codex execution

- Kept Cancel available for running and ordinary waiting Chat turns with control-local progress, retained history and explicit uncertain-effect recovery.
- Unified Chat Codex and Team developer execution without WorkLite proposal confirmation or exact-command grants; retained direct Chat Shell and non-Codex Team role authorization.
- Aligned CLI and thread permissions with writable WorkLite tools while keeping native environments disabled. No historical task replay or new migration is added. The subsequent operator deployment passed Gateway/Web builds, API compilation, isolated preflight and Web/API/Gateway readiness; the original Chat conversation remains cancelled.


### 2026-10-08 — Chat Codex invocation repair

- Resolve captured model_catalog_json against the selected launch home before passing CLI overrides; Codex CLI overrides require an absolute path. cx/cxo authentication and execution boundaries remain unchanged.
- Chat diagnostic Skill reads return current execution evidence, lifecycle events and receipt/submission metadata instead of repeated snapshots and rendered cards. Successful snapshot-tool outputs are explicit references; a toolCallId selects their full retained evidence. The full records HTTP route remains available without truncation.
- At inference time, full conversation-record tool results containing replay snapshots become explicit retained-evidence references. Stored model messages and original tool output remain unchanged, so a previously oversized dialogue can continue without repeating its effects.
- Report provider context-length rejection as an invalid request rather than an internal error. No automatic context deletion or uncertain-effect replay is added.

### 2026-10-07 — Retired Chat question recovery

- Fixed obsolete unstarted Shell grant questions retaining waiting_for_input after task-confirmation cutover and rejecting every later Feishu message.
- Database startup now cancels only the bound never-reserved call and its turn, retains a non-execution result and audit record, and clears the invalid pending question without granting commands or replaying requests. Agent initialization persists a current snapshot when the old replay state is stale.


### 2026-10-07 — Chat task confirmation

- Replaced Chat per-command grant forms with one persisted proposal confirmation for the current task, shared by direct Shell and delegated Codex execution; a new ordinary turn clears it.
- Preserved Commands evidence, interrupted-effect recovery, cx/cxo launches, Team exact-command grants and separate managed-release confirmation. Old command questions and tasks do not acquire task approval automatically.


### 2026-10-07 — Chat direct Shell

- Added conversation-owned `bash` execution independent of Codex and Team, using exact structured command grants, atomic Command reservation, retained results and explicit interrupted-command recovery.
- Reused Web and Feishu command forms and tool details; retained cx/cxo Codex launch modes and independent managed-upgrade ownership.


### 2026-10-07 - Codex launch homes and startup failure evidence

- Corrected the App Server minimum to the source-verified 0.157.1 protocol; startup errors retain a safe specific reason and backend Command reference.
- Support operator-selected `cx` and `cxo` launch forms with captured home/model/Provider/inference settings and local authentication, keeping native tools excluded and exact command grants authoritative. Older execution snapshots require a new task or Run.
- Use the existing locked `smol-toml` parser as an explicit API dependency for the launch configuration; do not evaluate `.zshrc` or copy credentials.

### 2026-10-07 - Contextual new conversation

- Chat recognizes new-conversation intent and exposes a single request-bound action in Web or Feishu. User activation creates the next execution and updates channel binding; no fixed reply menu, history deletion or implicit task cancellation is added.

### 2026-10-07 - Isolated local deployment Web build

- Build Web into a temporary directory and serve that candidate during local deployment preflight. Publish it to the deployment Web directory only after isolated readiness passes, so a failed preflight leaves the active Web resources untouched.

### 2026-10-07 - Chat-owned Codex App Server tasks

- Approved an independent Chat execution entry for Codex tasks, without Team planning, intake, queue or Run dependencies.
- Capture executable arguments, Gateway Responses model, project instructions and turn capabilities; persist task progress, exact-command grants and effect evidence under Chat.
- Reuse App Server transport and Commands while preserving disabled native execution, explicit uncertain-effect recovery, cancellation and shared Web/Feishu conversation delivery.
- Synchronize Chat guidance, platform Skill, contracts, capability metadata and repository conventions. Existing histories remain intact; no engine fallback or task migration is added.

### 2026-10-06 - Native Feishu card presentation

- Adopted CardKit entities, native fast typewriter rendering, separate status/reply updates, and collapsed task details.
- Persisted ordered idempotent delivery state inside existing rendered-card JSON; kept all task controls and command grants in their domains.
- Added the CardKit permission requirement and intentionally omitted conversion of existing message cards.

### 2026-10-09 - Interrupt active work during managed upgrades

- Replaced the 15-minute task-drain and automatic resume policy for operator and Chat-authorized upgrades with active-work cancellation after isolated candidate readiness succeeds.
- Keep matching program/data rollback on candidate startup failure, while leaving interrupted tasks cancelled and uncertain external effects subject to explicit recovery.
- Require deployment instructions, Chat knowledge, contracts, scripts, and capability metadata to describe the same interruption policy.

### 2026-10-05 - Resuming Cancelled Workflow Runs

- Extended the existing Workflow Run resume command to accept a cancelled Run that still has persisted scheduler state, exposed through a server-owned Run `resumable` flag.
- Re-entered the interrupted active Node Run without rerunning successful predecessors, committed outputs, edge traversal counts, or Artifacts; no node-internal checkpoint or Run-level rerun was added.
- Preserved cancellation and continuation as replayable Run evidence and retained node idempotency records, including WeChat draft reuse when a platform draft identifier exists.
- Updated the Run detail contract and synchronized Chat, platform Skill, typed contracts, and capability metadata without a schema migration, compatibility route, or service lifecycle change.

### 2026-10-05 - Codex App Server developer execution in Agent Team

- Confirmed the Codex plugin as the developer role's execution engine using local App Server stdio; Team retains orchestration, authorization, review, evidence and recovery.
- Capture executable arguments and backend in new immutable TeamVersions; older developer snapshots are not migrated or given an execution fallback.
- Bridge captured tools through the existing journal, disable native execution environments, and keep exact-command grants authoritative. Add Commands-owned bidirectional process transport and Team progress references.
- Keep model requests on the current Gateway with an explicitly Responses-compatible developer Provider. Require Codex 0.160.0 or later; synchronize Chat, platform Skill and capability metadata without changing Web configuration or running services.

### 2026-10-05 - Chat log inspection and Team-owned repair

- Added protected platform scripts for Gateway statistics, paged request logs and complete request detail, reusing the current profile's existing read APIs and retention contract.
- Assigned troubleshooting evidence and dispatch to Chat, and all repository repair and verification to Agent Team through durable intake and its existing authorization boundary.
- Removed Chat's built-in `bash` and `write` tools without a compatibility path; Team role tools remain independently configured. Synchronized the built-in Chat prompt, platform Skill references/contracts, capability snapshot and repository conventions.
- No schema migration, new API, service lifecycle operation or automatic repair is introduced. Product-owned Skill updates are installed by the existing startup bootstrap; accepted turns retain their captured Skill package.

### 2026-10-04 - Dedicated Chat workspace and communication channels

- Replaced the embedded Chat Bot with `/chat`, direct Web conversation, server-owned complete history, channel configuration and full saved conversation evidence.
- Defined Web and Feishu as channels of one protected Agent, moved Feishu configuration out of Plugins, and kept channel binding and rendering inside the transport adapter.
- Preserved existing persisted identities and histories; removed the former Feishu Web entry without compatibility redirects. Future WeChat transport is not implemented.

### 2026-10-04 - Natural Feishu dialogue and contextual choices

- Removed persistent target switching and unconditional capability menus; each new message enters Chat dialogue and task choices answer only its current question. Previously saved chat targets are ignored without migration or compatibility actions.
- Allowed Chat clarification without a multi-step plan and retained the existing question/answer and domain dispatch boundaries.
- Persisted queued reply placeholders with accepted messages and defined concise progress in the same card, with no completion label for successful ordinary replies.

### 2026-10-04 - Feishu application device registration

- Added the approved one-action QR registration path, encrypted resumable device state and automatic application credential/open-id persistence; missing user information keeps the connection disabled.
- Retained manual enterprise application configuration and explicit platform setup guidance, without changing local CLI credentials or adding user OAuth.

### 2026-10-04 - Conversational capability updates and managed upgrades

- Separated user Chat extensions from repaired product knowledge and captured capabilities per conversation turn.
- Defined a release-bound Feishu confirmation and independent upgrade journal, isolated preflight, task handoff, matched program/data rollback, and notification after reconnect.
- Required an operator-authorized managed runtime baseline; implementation does not operate existing services.

### 2026-10-04 - Feishu master conversation

- Replaced the Codex-bound WeChat ClawBot transport with an independent Feishu private-chat plugin using the official outbound WebSocket SDK.
- Made Chat the shared master Agent for Web and Feishu, with server-owned Team intake and published-Workflow dispatch, durable external submissions, task bindings, interactive actions, progress and file delivery.
- Extended Chat's Team authority to intake submission while preserving exact command grants, one active Team Run, immutable versions, existing execution evidence, and Official Account publication.
- Removed ClawBot routes and credentials without compatibility or conversation migration. Services are not restarted automatically.

### 2026-10-03 - Agent Team Conversation and File Delivery

- Approved the Team-owned Coordinator conversation as the default direct Team experience, with deterministic durable intake and configuration moved to a top tab.
- Added durable Team conversation, intake, message, and replayable event contracts keyed by a stable submission id, while retaining existing Team Run mutation and evidence APIs as authoritative.
- Defined directory memory as a still-valid recent selection reused silently and explicitly separated natural-language answers from exact-command authorization.
- Separated immutable `document.committed` evidence from managed-file availability, adding `document.delivered` and `document.delivery_failed`; conversation file messages expose only delivered immutable documents and retain Team Run document ownership.
- Added public conversation and Team document detail/download routes, including managed-file redelivery without role rerun and persisted conversation replay from `Last-Event-ID`.
- Kept Chat within inspection and existing-Run continuation: it never sends conversation messages and never starts or dispatches Team Runs; its Team starter only navigates. A direct-origin active Run queues later conversation intake, and direct-origin answers remain Run-only evidence.

### 2026-10-03 - Agent Team Cancellation Recovery

- Made uncertain-effect recovery take precedence over terminal cancellation so aborting a dispatched command cannot hide its recovery decision.
- Preserved operation-recovery inputs across cancellation requests and restart reconciliation; a later structured recovery decision settles the effect and supersedes the pending cancellation request when continuing.
- Kept the public REST/SSE contracts, typed operation-decision contract, and recovery route unchanged while synchronizing Chat guidance, the complete `worklite-platform` Skill package, and platform snapshot capability metadata.

### 2026-10-03 - Agent Team Web Interface

- Approved direct Web routes for the one built-in Team and its immutable-version Team Runs, with no Team collection, creation, or deletion route.
- Kept Team authorization, execution, evidence, and recovery on the Team routes and made the Chat contribution a navigation starter rather than Team dispatch.
- Kept the existing REST/SSE boundary authoritative for configuration, Run creation, observation, answers, operation recovery, and lifecycle controls.

### 2026-10-03 - Agent Team Implementation Direction

- Recorded the user-confirmed combination of BMAD and TEA process content with LangGraph.js Team execution, and linked the detailed implementation plan.
- Distinguished the planned TeamRun and embedded Team role configuration from the implemented Workflow scheduler, Workflow Agent nodes, Artifact production, and Home eligibility.
- Identified process packaging, shared execution tools, project-directory context, checkpoint recovery, and platform knowledge synchronization as implementation work rather than current capabilities.
- Added the approved internal implementation increments without exposing Team APIs: pinned process packaging, Team persistence, isolated role invocation, effect journaling, LangGraph checkpoints and recovery, captured project instructions, role-scoped process references, and managed run output.
- Required exact-string command authorization for Team `bash` execution, made pending-input command grants structured and cumulative, persisted the grant set on each TeamRun, and excluded executable Skill scripts from Team roles until their full command can be represented and authorized exactly.
- Imported the complete pinned TEA `bmad-testarch-automate` workflow directory as Test Author's direct reference closure; Test Runner remains backed by WorkLite Commands rather than upstream process content.
- Defined durable Agent Team operation recovery: uncertain effects expose a structured pending decision, terminal linked Commands can be adopted without replay, explicit failures settle without replay, and any replay is a separately authorized new operation while the original uncertain record remains immutable.
- Kept Chat, `worklite-platform`, snapshot capability metadata, and reference protections unchanged until public Team operations were implemented together.
- Implemented the P3 public Team boundary: one built-in Team is readable and configurable, Runs are workspace-scoped and controllable, persisted Run events replay from `Last-Event-ID` before live delivery, operation recovery is addressable by its operation key, and platform guidance, scripts, snapshot metadata, and Skill/MCP reference protections expose only these implemented operations. Team creation/deletion and a dedicated Web UI remain unavailable.

### 2026-09-26 - Atomic Artifact Node Completion

- Commit an Artifact row together with its successful NodeRun result and scheduler state so a failed node completion cannot leave an Artifact detached from the committed invocation.
- Publish `artifact.created` only after the transaction succeeds.
- Reuse the existing tables and API contract; no data migration is required.

### 2026-09-23 - Per-Element TypeSafe Evaluation

- Added the first-party `typesafe/systemone-map@1` Node Type, which evaluates one immutable typed question set against every element of an array inside its committed `state` input and returns those elements with their typed `answers` merged in.
- Kept the iteration inside one node invocation. Each element is one upstream System One request with its own Gateway request log, while the scheduler still sees one token, one invocation, one committed output, and one NodeRun. Port-level joining and concurrent branch execution remain deferred and are unaffected.
- Scoped each element's request state to `{ item, context }` so an element carries only its own content plus the shared context the author addressed with `contextPath`, rather than the whole upstream package.
- Added deterministic server-side `rank` ordering, thresholding, and truncation to the node configuration, keeping selection in code while the model supplies only the typed per-element judgement.
- Bounded upstream concurrency per invocation and failed the node under its ordinary error policy when an element fails, so a partially evaluated array is never committed as a complete result.

### 2026-09-22 - Workflow Run Pause and Resume

- Added Run-level pause for queued or running Runs and resume for paused Runs without a mid-node checkpoint.
- Preserved scheduler state and completed predecessors, reran only the interrupted active invocation after resume, and left durable human-gated waiting unchanged.
- Kept paused Runs observable and restart-stable, allowed their cancellation, and made them continue to prevent scheduled overlap.

### 2026-09-22 - Readable Provider API Key

- Made the Provider API key readable through Gateway administration responses so the edit form can prefill the stored key instead of presenting an empty write-only field.
- Scoped the change to the Provider API key: MCP authentication tokens and Provider custom-header values remain write-only, and the workspace platform snapshot, Skill scripts, logs, and errors still exclude every Provider credential.
- Accepted the resulting exposure: the key reaches the browser on every Provider list read. This is coherent for a single-user local installation and matches the existing local Codex credential handling.
- Removed the edit-only `keep current key` placeholder, which described a blank field that no longer exists. Submitting an empty key still preserves the stored key.

### 2026-09-22 - AI SDK Workflow Agent Tool Loop

- Replaced the hand-written Workflow Agent model/tool round loop with AI SDK `ToolLoopAgent`, `stopWhen`, and `prepareStep` loop primitives behind a provider-neutral Model Gateway request.
- Kept WorkLite ownership of Skill execution, MCP execution, sequential tool dispatch, budgets, cancellation, activity events, Workflow persistence, retry, Artifacts, scheduling, and Portkey correlation.
- Preserved streaming-primary transport, bounded retry before emitted output, one non-stream fallback per model call for the empty-stream/no-output case, Responses non-strict tool schemas, JSON output handling, and context trimming.
- Explicitly excluded Chat migration, a Workflow engine replacement, new persistence schemas, REST contract changes, UI changes, and new agent-framework dependencies.

### 2026-09-22 - Credential-Forwarding TypeSafe System One Provider Protocol

- Added the `typesafe/systemone` Provider protocol and the `/api/portkey-gateway/v1/systemone` unified route for an upstream whose contract exchanges a `state` value and typed `questions` for typed `answers` instead of chat messages.
- Defined the transport as credential forwarding rather than translation: the Gateway resolves the Provider from the `<providerName>/<modelId>` namespace, substitutes the upstream model id, attaches stored credentials and headers, and passes the request and response bodies through unchanged. No chat adaptation layer was added in either direction.
- Recorded statistics and request logs directly from the forwarding path because a passthrough request never populates the Portkey handler request options the shared log middleware reads. Existing `input_tokens` and `output_tokens` handling covers its usage reporting.
- Excluded this protocol from Agent model selection, since an Agent node's system prompt and output format have no meaning in a contract with no message list. Its connection test sends one minimal typed question, and its model catalog is manual because the upstream publishes no model-discovery endpoint.
- Aligned the connection-test API contract with the protocol: System One results return the typed input and typed output, while upstream failure reasons and the correlated request-log id survive the API proxy.
- Initially kept the protocol out of Workflow nodes; the separate Workflow integration is now defined and implemented below as `typesafe/systemone@1`.

### 2026-09-22 - TypeSafe System One Workflow Node

- Added the first-party `typesafe/systemone@1` Workflow node with a required JSON `state` input, an upstream response output containing typed `answers`, and immutable `model` and `questions` configuration.
- Reused the Gateway's credential-forwarding System One path through an internal API runtime method. Workflow versions store neither Provider credentials nor Gateway connection details, and the existing exclusion from Agent model selection remains unchanged.
- Added structured answer-path routing support through the existing edge condition contract; no new graph schema version, database table, Provider migration, or compatibility alias is required. Existing Workflow versions are unchanged.

### 2026-09-22 - TypeSafe Workflow State Pass-through

- Kept object state fields in `typesafe/systemone@1` node output and overlaid the upstream typed response so a typed classifier can route without discarding its upstream Workflow context.
- Exposed primitive and array state under `state`; Gateway transport remains unchanged and still forwards the System One response unchanged.
- Defined the pass-through as a Workflow runtime contract so existing Workflow versions remain immutable and only newly published versions use it.

### 2026-09-22 - Generic JSON Choice Branch

- Added the provider-independent `worklite/branch@1` node with a required JSON `value` input and unchanged JSON output.
- Made Choice Branch outgoing routes exclusive: the scheduler traverses the first matching structured condition in edge-definition order, or the first fallback when no condition matches. Existing non-branch nodes retain their fan-out behavior.
- Exposed the node in the editor palette, capability snapshot, built-in Chat prompt, and `worklite-platform` Skill contracts so Agent and future typed-answer producers can reuse the same JSON routing contract.

### 2026-09-21 - Author-Controlled Edge Cardinality and Branched Research Article Kinds

- Replaced the one-incoming-edge-per-port invariant with author-controlled cardinality so mutually exclusive branches can converge on a shared input port. The token scheduler already queued tokens per port and is unchanged; only graph validation was relaxed, and the Agent `context` initial-plus-bounded-feedback pair and the unconditional Workflow Input edge rules are retained.
- Kept port-level joining deferred and stated the consequence explicitly: a single-value port that receives two tokens produces two independent invocations rather than one merged call, so exclusivity is expressed through predicate and fallback conditions or a routing node and is not verified by the engine.
- Branched the research workflow on a planner-declared article kind, giving survey and explanatory articles their own retrieval and writing nodes that reconverge on the shared review, approval, artifact, cover, and WeChat publication path instead of duplicating the whole chain.
- Made evidence retrieval choose a primary source from the subject rather than spending a fixed allowance on every Skill, so a GitHub-centred question investigates GitHub and uses community search only for what GitHub cannot show, and an unrelated source is correctly left uncalled.

### 2026-09-21 - Fail-Closed Research Article Review

- Made editorial review a verdict-only model step; server-owned JSON passthrough retains the writer's original Markdown and evidence without model reproduction.
- Added optional bounded Workflow Agent tool calls and rounds and a deterministic approved-article gate that rejects unapproved, duplicate, or structurally malformed Markdown before Article Artifact and WeChat draft creation.
- Limited research revisions to one, removed the model-based article finalizer and publication after exhausted feedback, and left historical immutable versions and existing drafts untouched. New behavior requires a new published Workflow version and updated runtime.


### 2026-09-21 - Workflow Agent JSON Output Contract

- Added an optional `outputContract` to the `worklite/agent` JSON mode: a non-empty array of unique non-empty strings naming top-level keys the parsed output must carry. Runtime enforcement rejects a parsed value that is not a JSON object or that omits a named key or carries it as `null`, an empty string, or an empty array, and the failure names the absent keys.
- Recorded why parsing alone is insufficient. A JSON-mode Agent previously committed any well-formed JSON, so a research node that returned a progress note such as `{"summary":"..."}` or a raw tool-call object was recorded as succeeded and every downstream node consumed that value as its evidence. The defect was invisible at runtime and only discoverable by reading persisted node payloads afterwards.
- Scoped enforcement to a presence check on top-level keys. `inputSchema` and `outputSchema` remain capability metadata that the runtime does not enforce, and full JSON Schema validation for node inputs and outputs remains a separate architecture decision.
- Reused existing failure semantics: a contract failure follows the node's `errorPolicy` and the existing failed-node retry path, and introduces no new Run or Node Run state.
- Added publication validation requiring `outputFormat: "json"` alongside `outputContract` and a well-formed key list. Per the compatibility policy there is no migration or adapter: a node that declares no contract behaves exactly as before, and existing published versions and historical runs are unaffected.

### 2026-09-21 - Dedicated Logs Destination and Absolute Time Ranges

- Moved Gateway statistics and request logs out of the Providers destination into a dedicated Logs destination that owns transport observability, leaving Providers with Provider administration and the Codex account pool. Providers no longer exposes the `statistics` and `request-logs` views.
- Replaced the `window=24h|7d|30d` statistics parameter with explicit absolute `from` and `to` ISO-8601 instants on `GET /api/portkey-gateway/stats`, and added the same range parameters to `GET /api/portkey-gateway/request-logs`. A named relative window cannot express an arbitrary interval such as one afternoon, and resolving a name on the server makes a shared link mean a different interval for each reader, so preset naming belongs to the client. Per the compatibility policy, the `window` parameter is removed without an alias; any caller still sending it now receives the default 24-hour range.
- Defined range validation for both routes: an omitted range resolves to the last 24 hours ending now, `to` beyond the current instant is clamped, and an inverted range is rejected.
- Recorded the permanent retention asymmetry between the two stores for one shared range: statistics cover the whole range, request logs cover at most its trailing three days. A request-log range beginning before the retention window is served as the intersection rather than rejected, and the truncation is stated on the read surface instead of returned as a failure.
- Confirmed that the new destination does not merge Gateway observability with the API-owned Usage read model or Audit Log, and gains no WorkLite data source.

### 2026-09-20 - Chinese-only Web Interface and Provider Configuration Interactions

- Removed the Web language-selection contract and made the interface use the Chinese resource set only.
- Removed locale from workspace settings persistence, Agent settings tool results, CLI contracts, and the database schema through migration `0015_remove_workspace_locale`.
- Required Provider Test to open without sending a request; the user must explicitly choose or confirm a model and activate the test action.
- Replaced the free-form model token editor with an ordered draggable model list; discovery appends unique models and persistence retains the displayed order.


### 2026-09-20 - Remove Standalone Agent Capability

- Removed standalone Agent resources as a user-facing capability because Workflow Agent nodes provide the complete configurable Agent behavior.
- Kept Chat as a protected shell and Home entry point, with no Settings destination or standalone Agent resource route.
- Kept Workflow Agent nodes and the shared internal execution runtime.


### 2026-09-20 - Provider Attribution for Gateway Statistics

- Added explicit internal Provider attribution from the model gateway to Gateway request observability, so internal model calls no longer depend on a provider-prefixed model id to populate statistics.
- Kept explicit attribution ahead of model-prefix inference and retained `Unknown` only for requests that provide neither reliable attribution source.
- Kept the attribution header internal; it is not included in the configured upstream header-forwarding list.

### 2026-09-20 - Unified Gateway Request Logs and Token Statistics

- Kept request details and aggregate statistics under the Providers observability surface while separating their storage lifecycles.
- Defined `gateway_request_stats` as the permanent lightweight statistics store and `gateway_request_logs` as the three-day detail store.
- Standardized input, output, and total token extraction across OpenAI-compatible and Anthropic-style usage fields, calculating total tokens only when input and output are both available.
- Required one shared normalized request outcome to write both records, without persisting request or response bodies in the permanent statistics store.

### 2026-09-21 - Workflow Node and Provider Log Read Surfaces

- Recorded that the 2026-09-20 observability increment was documented but never implemented: `gateway_request_logs`, `node.activity`, Run and Node correlation metadata, and the Diagnostic Logs removal did not exist in the codebase. This entry supersedes it and is the implemented contract.
- Defined `node.activity` phases explicitly: node setup, each execution attempt including automatic `retry` attempts, Agent model rounds, Skill script invocations, MCP tool calls, and post-commit edge decisions with evaluated conditions.
- Required Skill script activity to reference its `command_executions` identifier instead of copying stdout and stderr, so `command_execution_events` remains the single owner of streamed script output.
- Required clients to apply activity events incrementally rather than refetching Run detail per event, and recorded that Run events are retained for the life of their Run with no separate activity retention window or truncation.
- Made `/runs/:runId` a routable deep log-reading destination alongside the Workflow List Run records dialog, with both surfaces reading the same Run detail and event stream.
- Added the Gateway request-log read routes `GET /api/portkey-gateway/request-logs` and `GET /api/portkey-gateway/request-logs/:requestLogId`, presented in the Providers destination next to aggregate statistics.
- Recorded that correlation values are internal `x-worklite-*` headers excluded from every Provider `forward_headers` allowlist, and that one request-log row represents one upstream attempt.
- Made request logs non-deletable with retention expiry as their only removal path, and recorded the asymmetry that a Run outliving the three-day window keeps its node activity after its correlated provider bodies expire.
- Replaced the Provider connection test's diagnostic trace with its own correlated Gateway request log; test failures return that request-log identifier.
- Removed the API Diagnostic Logs capability for real: the `diagnostic_logs` table, its service, the `/api/diagnostic-logs` route, and the `/settings/logs` page are deleted with no redirect or alias, and the unreachable `testProvider` path behind it is removed.

### 2026-09-20 - Unified Provider and Workflow Request Observability

Superseded by the 2026-09-21 entry. The decisions below were approved and documented but never implemented; treat the later entry as the authoritative contract.

- Added Gateway-owned durable Provider request logs separate from aggregate request statistics. Every request captures the transformed request and complete non-stream or streaming response details without headers or credentials.
- Fixed request-log retention at three days with automatic cleanup during Gateway initialization and log writes.
- Added opaque Workflow Run and Node Run correlation metadata for linking model requests to Workflow node activity.
- Extended Workflow Run detail with node input, output, streamed output, and replayable `node.activity` events for model rounds, Skills, and MCP calls.
- Removed the standalone API Diagnostic Logs capability; Provider tests use unified Gateway request logs instead, and old diagnostic records are removed by migration.

### 2026-09-20 - Provider Protocol Selection

- Added the explicit `anthropic/messages` Provider protocol for Claude Messages requests.
- Removed `deepseek/chat` from current Provider configuration and runtime contracts.
- New Provider forms require an explicit protocol selection and do not migrate or alias existing `deepseek/chat` records.

### 2026-09-19 - GitHub Evidence Depth for Article Substance

- Identified the cause of empty article content: the `github-current-popularity` Skill queried only `search/repositories`, so every claim about a project could rest on nothing deeper than its one-line description. No prompt or model change can supply material the research step never retrieved.
- Extended the Skill script with README text, in-window commit subjects, release notes, and the most-discussed issues and pull requests for a bounded set of studied repositories, and traded breadth for depth by reading a few leading repositories in full rather than listing every search hit.
- Recorded in the Skill instructions and the research prompt that a repository description is a self-applied label, not evidence for mechanism, change, or user agreement, and required each article paragraph to trace to README, commit, release, or discussion evidence.
- Ranked article substance above the stylistic rules in reviewer approval, so a draft assembled from descriptions and star counts is rejected however well it reads, and required at least one concretely falsifiable mechanism passage and one real disagreement drawn from project discussion.
- Capped reviewer feedback at three severity-ordered items scoped to sentences or paragraphs. Unbounded broad feedback drove four consecutive rejections in which each pass narrowed claims further, ending in a draft that was rigorous and empty; a whole-section rewrite request also introduced a fabricated repository creation date.
- Required uncertainty to be carried in the wording of a claim instead of a trailing disclaimer sentence, since splitting the previous limitations section into per-paragraph disclaimers relocated the audit-report tone without removing it.
- Required the retrieval window to be stated once in the body where search evidence first appears. Forbidding a sampling-method section had removed the window entirely, leaving window-dependent claims uninterpretable.
- Replaced unmeasurable rhythm guidance with checkable bounds on paragraph and sentence length, and required sections to build on each other rather than partition the subject into reorderable parallel categories.

### 2026-09-18 - Per-Role Research Workflow Models and Reader-Facing Article Quality

- Replaced the research seed's single-model-for-every-Agent rule with per-role model assignment resolved against the target profile's Gateway catalog, so planning and cover-prompt work runs on a fast model, research and finalization run on the strongest verified writing model, and editorial review runs on a different provider family.
- Justified the cross-family reviewer on the ground that a model cannot reliably detect its own stylistic habits, and paired it with the `retry` error policy because the selected cross-family provider has a measurably higher observed failure rate than the writing provider.
- Made reader-facing writing quality an explicit reviewer approval requirement alongside publication formatting: a concrete, claim-bearing title with no formulaic decoration, an opening that states a finding instead of background, no self-referential narration, no section headings that mirror the research JSON fields, bounded section count, varied sentence and paragraph length, interpreted rather than enumerated data, and a references section limited to sources the body actually uses.
- Kept structured evidence, counterexamples, and limitations in the Research Notes Artifact while forbidding their reproduction in the article as mirrored sections, so evidence rigor is unchanged and only its presentation is constrained.
- Aligned the documented seed with the published graph by folding duplicate screening into the reviewer Agent, removing the separate screening node, and carrying historical candidates through the research payload.
- Restored the reviewer-to-finalizer edge to a `fallback` condition. A bounded feedback edge plus a `$.approved === true` predicate strands the Run with no article once the traversal bound is exhausted, because the scheduler traverses a fallback edge only when no predicate edge matches.

### 2026-09-18 - Failed Node Retry and WeChat Draft Failure Reasons

- Replaced the deferred resume-from-failure boundary with a manual single-node retry command at `POST /runs/:runId/nodes/:nodeRunId/retry`, accepted only for a `failed` Run whose requested NodeRun is the persisted active invocation.
- Retry re-enters the same NodeRun through the existing scheduler-resume path, so committed predecessor outputs, ready queue, and edge traversal counts are unchanged and no duplicate NodeRun row is created. Retrying an earlier successful node remains deferred.
- Exposed server-owned retry eligibility on each Node Run in the detailed Run contract so clients never inspect internal scheduler state.
- Made a WeChat publication record with an existing platform draft identifier reopen that draft even while its own status is `failed`, so a retry cannot create a second official-account draft.
- Required draft-mode failures to surface the platform's own credential-safe status text or blocking dialog text instead of a generic missing-draft-identifier message.
- Required draft-save responses to be classified as accepted or rejected before any failure text is derived, since a WeChat success response carries both a zero status code and an `ok` message.
- Made the editor URL's `appmsgid` parameter an authoritative draft-identifier source for an accepted save whose response body omits it, and separated an unexposed identifier from a platform rejection as its own reported condition.
- Kept the per-node `retry` error policy as the automatic in-run attempt mechanism; manual node retry is an independent recovery command.

### 2026-09-18 - Artifact History Query and Research Duplicate Screening

- Added a read-only, workspace-scoped `worklite/artifact-query@1` node with explicit JSON request input, configurable top-level title and description fields, deterministic history ordering, and compact candidate metadata; detached historical Artifacts remain eligible without a database migration.
- Allowed an Agent context to combine one unbounded initial upstream edge with one bounded feedback edge, retaining the unconditional Workflow Input rule and existing implicit initial invocations.
- Placed title-and-description planning and semantic duplicate screening before research in the GitHub Technology Trend Research seed. Only an explicit nonduplicate decision advances; historical Research Notes may include unfinished drafts, and semantic decisions remain model-dependent.
- Kept existing immutable published versions unchanged; the operator-run seed publishes a new version when invoked. No deployment data or service changes are implicit.

### 2026-09-17 - Workflow Image Generation and WeChat AI Covers

- Added `worklite/image@1` with required prompt input, the constrained `codex/gpt-image-2` generation contract, and in-memory Workflow image JSON output.
- Added `wechat-official-account/publish@2` with required article and generated-cover inputs while preserving immutable version-1 execution for previously published graphs.
- Kept generated base64 image data out of NodeRun records, event payloads, terminal Run results, Run detail views, and WeChat publication records while retaining it in persisted scheduler state only long enough for downstream execution and resume.
- Updated newly created editor and seed WeChat nodes to use version 2 and upload the generated PNG through the real Playwright MP cover picker.
- Deferred image edits, generic provider abstraction, binary Artifacts, image libraries, image conversion, direct WeChat APIs, no-cover fallback, and dynamic joins.

### 2026-09-17 - Codex Image Generation Transport

- Extended the Gateway-owned `codex/responses` Provider adapter with a dedicated Codex Images generation transport and exposed `POST /api/portkey-gateway/v1/images/generations`.
- Advertised `codex/gpt-image-2` from the automatic Codex Provider while retaining OAuth account-pool selection and one-shot selected-account unauthorized refresh.
- Forwarded only the supported Codex generation fields and returned upstream `data[].b64_json` responses; image edits and binary Artifacts remain unsupported.

### 2026-09-17 - Explicit Workflow Input Agent Edges

- Allowed one unconditional, unbounded `worklite/input.output` edge to share an Agent `context` port with one bounded feedback edge, making initial data flow explicit without introducing dynamic joins.
- Retained implicit Workflow-input seeding for existing Agent graphs whose only incoming context edge is bounded; existing schema-version 4 definitions remain valid without migration.
- Rejected conditional, bounded, duplicated, or unbounded-forward combinations on the same Agent context so initial tokens and feedback remain sequential and unambiguous.

### 2026-09-16 - Conditional Edges and Bounded Loops

- Extended Workflow edges with structured output predicates, fallback routing, and optional positive traversal bounds without introducing executable expressions.
- Replaced one-pass topological execution with a deterministic sequential token scheduler whose queue, pending inputs, traversal counters, and terminal outputs are persisted in each WorkflowRun.
- Allowed repeated node invocations with one ordered NodeRun per invocation, seeded nodes with no unbounded incoming edges and no connected required inputs for their initial invocation, required every cycle to cross at least one bounded edge, and intentionally rejected resumptions that contain legacy Node Runs without persisted scheduler state.
- Kept existing unconditional acyclic edges valid, retained one incoming connection per single-value port, and continued to defer dynamic joins and concurrent branch execution.
- Added edge-inspector configuration and condition or loop labels to the existing React Flow editor instead of adding a second orchestration surface or LangGraph runtime.
- Updated the repeatable research seed with up to three bounded editorial feedback traversals, constrained article finalization, reference-only article links, and WeChat draft saving.

### 2026-09-16 - Responses Agent Tool Compatibility

- Fixed Agent system prompt delivery by replacing the unrecognized top-level `instructions` parameter with the AI SDK `system` parameter so both Chat Completions and Responses providers receive the prompt.


- Kept `openai/responses` as the explicit Provider protocol for GLM while adding Agent Runtime compatibility for Responses providers that do not support OpenAI strict function-tool schemas.
- Made Responses Agent function tools non-strict and disabled request-level AI SDK strict JSON Schema handling for those requests.
- Allowed the repeatable research seed to select a GLM Provider using `openai/responses`; explicit `WORKLITE_MODEL` values continue to resolve through the public Provider/model namespace.
- Changed no Provider protocol, Workflow immutable version, or public model namespace.

### 2026-09-16 - Model Gateway Empty Stream Recovery

- Captured original upstream errors from empty Agent model streams instead of replacing them with a generic no-output failure.
- Kept bounded retry behavior before output and added one non-stream fallback only for an un-aborted AI SDK no-output result.
- Updated the repeatable research seed to resolve a configured GLM model or an explicit public `WORKLITE_MODEL` instead of binding to MiniMax.

### 2026-09-16 - Pending Workflow Authentication

- Added persisted `waiting_for_input` Workflow and Node Run states with resumable pending actions.
- Added the built-in WeChat Official Account Plugin and its Playwright-backed publish node, including login and final-publish QR confirmation.
- Required account-scoped serialization and Run-plus-node idempotency so QR refresh and Run continuation cannot duplicate a draft or publication.
- Kept scheduled draft creation available while rejecting Timer plus direct publish in the initial increment.
- Updated the repeatable research seed to synchronize its draft and publish the immutable version that contains the direct-publish node.

### 2026-09-15 - Chat Workflow Mentions

- Approved invoking published Workflows from the workspace chat with `@Workflow` mentions.
- Resolve the mention by workspace-scoped Workflow name, pass the remaining message text as the Workflow Input value, and create the existing immutable-version Workflow Run.
- Keep Workflow execution separate from Agent sessions; show Run progress and resulting Artifacts in the chat transcript.
- Exclude Draft Workflows from executable mentions and do not add compatibility aliases or a second execution engine.

### 2026-09-15 - GitHub Technology Trend Research Workflow

- Approved a repeatable Workflow seed that mirrors the existing think-agent research-then-writing process with existing Input, Agent, and Artifact nodes.
- Kept research notes and the final article as separate successful-Run Artifacts instead of adding filesystem output behavior.
- Required the seed to resolve workspace resources by name and never copy external provider credentials.
- Intentionally did not add a new node type, standalone Agent dependency, Timer, Dashboard, compatibility alias, or credential migration.


### 2026-09-15 - Run Execution Logs and Artifact Eligibility

- Extended detailed Run responses with immutable-version Artifact-node eligibility while retaining ordered Node Run execution records and failure reasons.
- Defined Workflow Run records as the presentation surface for node status, timing, retries, and credential-safe failure context.
- Omitted Artifact presentation for Workflow versions without an Artifact node; eligible versions with no created Artifact retain an explicit empty state.

### 2026-09-15 - Development Port Range

- Changed the development Web, API, and Portkey Gateway defaults to `3390`, `3391`, and `3392` respectively.
- Kept local deployment ports `23390`, `23391`, and `23392` unchanged and intentionally provided no compatibility listeners or redirects for the previous development ports.

### 2026-09-15 - Explicit Artifact Nodes

- Added the first-party `worklite/artifact` Node Type with required JSON `data`, configured `name` and `text`/`markdown`/`json` type, successful-run Artifact persistence, and Artifact-reference output.
- Removed implicit Agent file-output and Agent-created Artifacts; Agent output is now text or parsed JSON only.
- Intentionally provided no compatibility or migration for old Agent file-output configuration.
- Allowed multiple Artifact nodes per Workflow.

### 2026-09-15 - Workflow-Scoped Run History Access

- Removed the standalone Run web routes and the `runs` System Helper navigation target.
- Kept the run detail, event, and cancellation HTTP contracts because the Workflow List Run records dialog and Home board rendering consume them.
- Made Workflow List the user-facing access point for each Workflow's Run history and intentionally omitted compatibility for removed Run routes and the removed navigation target.

### 2026-09-14 - Simplified Workflow Node Model

- Removed the first-party Text and Skill Set Node Types; system prompts and Skill selections are owned directly by the Workflow Agent node.
- Made Workflow Agent `context` optional and defined missing upstream context as the Workflow Run input.
- Intentionally provided no compatibility for existing definitions or published versions that contain the removed Node Types.

### 2026-09-15 - Compositional Dashboard Layout

- Removed the separate Home board detail view; eligible boards render as self-contained cards whose list content is a paginated up-to-three-column table.
- Added the `url` list display-field type; `url` fields turn list rows into links to the item value instead of rendering text, and `metric` elements do not support them.
- Replaced the Dashboard node's `title`, display fields, and `titleField` with a compositional layout of `header`, `main`, and `footer` element arrays.
- Defined the generic element kinds `text`, `count`, `metric`, and `list`, where `list` owns its `titleKey` and display fields and Home derives card previews from list elements.
- Removed the Dashboard node `description`; the node owns only the layout, the header region renders in the board card's former title area, and the board page title remains the Workflow name.
- Intentionally provided no compatibility; previously published Dashboard configurations must be reconfigured and republished to appear on Home.

### 2026-09-14 - Generic Board Output Format

- Defined the version 1 Dashboard board format: configured display fields plus a `titleField`, with object or object-array Dashboard output rendered generically as cards.
- Added `titleField` to Dashboard node configuration with publish validation against configured field keys.
- Kept rendering tolerant; output that does not match the format degrades to explicit empty or raw-JSON states instead of failing the node or board.

### 2026-09-14 - Structured Workflow Agent Output

- Added `worklite/agent` output-format configuration for text or JSON responses.
- Required JSON mode to parse the final model response into normal Workflow JSON output and fail invalid responses.
- Preserved Dashboard-node board eligibility and Run-derived Home output semantics.

### 2026-09-14 - Database-Backed Home Board Categories

- Added user-managed Home board categories as database-backed organization metadata.
- Kept Uncategorized as a presentation default for every eligible Dashboard-node board and enforced at most one category assignment per board.
- Preserved Run-derived board output and intentionally kept category deletion, assignment removal, and Workflow deletion from deleting or snapshotting Workflow output.

### 2026-09-14 - Dashboard Node Home Boards

- Added the first-party `worklite/dashboard` Node Type as the only Workflow-owned eligibility contract for a Home board.
- Limited each Workflow to one Dashboard node and defined immutable board title, description, and display-field metadata inside the WorkflowVersion.
- Removed platform-defined Workflow boards and Home-owned Workflow data projections; Home now selects only published Dashboard-node Workflows and reads their latest successful Run through the normal Run contract.
- Intentionally omitted compatibility behavior for existing Workflows and platform boards; they must be recreated or republished with a Dashboard node to appear on Home.

### 2026-09-14 - Timer Node Scheduling

- Removed the global Home Dashboard Workflow data source, fixed dashboard payload, and persisted dashboard dataset.
- Made `worklite/timer` the versioned graph source of truth for fixed-interval Workflow scheduling, limited each Workflow to one Timer with a minimum 300-second interval, and made Publish synchronize the internal `workflow_schedules` runtime projection.
- Removed independent schedule mutation and Dashboard-level schedule and Run now operations without compatibility routes; retained only read-only schedule runtime status and required future Workflow-output widgets to bind explicitly per widget.

### 2026-09-14 - Run-to-Artifact Traceability

- Removed the standalone Artifact collection web destination and the `artifacts` System Helper navigation target.
- Kept Artifact details directly routable and made expanded Run cards the run-to-Artifact traceability surface.
- Did not add a compatibility alias for the removed Artifact collection route.

### 2026-09-11 - Per-Account Codex Usage

- Added a Gateway-owned `GET /worklite/codex/accounts/usage` contract that fetches usage independently for every enabled Codex account and returns disabled or failed accounts without blocking the remaining pool.
- Kept usage snapshots read-only and non-persistent; account tokens remain Gateway-owned and never cross the API boundary.
- Defined the Providers page account pool as a separate management view instead of embedding account controls in the Gateway summary.

### 2026-09-10 - Codex Account Pool and JSON Import

- Replaced the single Codex OAuth credential with a Gateway-owned multi-account pool.
- Added account-export JSON import, per-account enable and disable controls, priority-aware round-robin selection, and configured concurrency enforcement.
- Defined account-local refresh and automatic pause behavior, retained rate multiplier as non-routing metadata, and ignored imported proxy definitions.
- Intentionally omitted a legacy single-account compatibility layer; existing credentials require re-authentication or import.

### 2026-09-10 - Dynamic Workflow Capability Planning

- Made the trusted registered Workflow node catalog the source of truth for runtime node execution, graph validation, and platform snapshot capability metadata.
- Added an assistant-facing logical Workflow Plan contract; the server owns node identifiers, layout, normalization, resource validation, port validation, and DAG validation.
- Updated System Helper guidance to inspect current capabilities and use controlled Workflow draft mutation scripts.
- Kept arbitrary remote node code loading, direct database writes, arbitrary URL/API calls, and runtime-extensible frontend node components out of scope.


### 2026-09-10

- Required the built-in System Helper platform Skill and platform snapshot capability metadata to stay synchronized with current Workflow architecture and editor capabilities. Workflow guidance now describes embedded Agent nodes instead of standalone Agent references.

### 2026-09-10

- Defined a platform-wide resource lifecycle for Agent, Skill, MCP server, Provider, Artifact, Run, immutable version, log, and built-in resource deletion.
- Defined permanent Workflow deletion across drafts, versions, schedules, dashboard datasets, and run history while retaining detached Artifacts.

### 2026-09-10 - Embedded Workflow Agent Nodes

- Separated standalone Agent and AgentVersion resources from Workflow definitions and execution.
- Replaced `worklite/generic-agent` with the self-contained `worklite/agent` node, which stores its public model id, system prompt, Skill selections, and MCP server selections in each immutable WorkflowVersion.
- Removed compatibility for legacy Generic Agent workflows; existing definitions must be recreated with the new Agent node.
### 2026-09-10

- Reframed WorkLite around Workflow automation and the customizable Home Dashboard.
- Defined the version 1 workflow-to-dashboard payload and one workflow-backed dataset per dashboard.
- Kept Plugins and Agents as peer capabilities while Skills and MCP servers serve Agents.
- Removed Meegle as a standalone product surface; Meegle personal todos are a generic scheduled-workflow use case.

### 2026-09-09

- Added versioned portable Workflow JSON export and import. Exports omit runtime and credential state; imports resolve Agent and Skill references in the destination workspace and create a new draft without publishing or scheduling it.


### 2026-09-09 - Scheduled Meegle Todo Board

- Added fixed-interval triggers for published workflows, with persisted next-run state and overlap prevention.
- Added a local Meegle todo read model populated from structured workflow results with deterministic snapshot comparison.
- Added internal change notifications and a personal kanban surface with manual synchronization.
- Intentionally omitted cron, webhook triggers, Feishu IM delivery, custom mappings, and scheduled-Agent-task compatibility.

### 2026-09-08 - Codex Rate-Limit Visibility

- Added a read-only Gateway-owned Codex rate-limit snapshot based on the open-source Codex client's account usage request and response shape.
- Kept rate-limit data ephemeral and separate from Gateway request statistics, authentication state, and WorkLite Usage rows.

### 2026-09-08 - Explicit Provider Test Model

- Required connection-test requests to name one configured Provider model instead of silently testing the first model.
- Kept the last test-model selection as browser-local state keyed by Provider id; no server persistence or compatibility fallback is provided.

### 2026-09-08

- Folded the former `worklite-platform` Skill into System Helper Chat as an internal platform-operation capability; it is no longer a workspace Skill resource or Agent assignment.

### 2026-09-07 - Automatic Codex Provider

- Made the Gateway automatically maintain a `codex` Provider when Codex OAuth or environment credentials are configured.
- Kept the automatic Provider out of browser CRUD creation and hidden it from Provider and model catalogs while Codex is unconfigured.
- Preserved the last known automatic model catalog when Codex model discovery is temporarily unavailable.

### 2026-09-04 - Local Deployment Script

- Added `scripts/install-local.sh` for dependency installation, Web build, background API/Web startup, and readiness checks.
- Reserved the `23390` deployment series: public Web `23390`, loopback API `23391`, and loopback Gateway `23392`; deployment state uses `.data/deployment` so it does not share development databases.

### 2026-09-04 - Explicit Gateway Provisioning

- Removed Gateway startup imports from the legacy Provider JSON registry and API SQLite database.
- Gateway Provider state is deployment-local and must be created by the Gateway administration API or an explicit provisioning script.
- Kept development and deployment isolated through separate database paths and port ranges; no implicit compatibility or synchronization path is provided.

### 2026-09-04 - Gateway-Native Codex Provider

- Moved direct Codex Responses transport into the Portkey Gateway process as an explicit `codex/responses` Provider adapter.
- Removed the separate Codex Proxy listener, deployment port, and inbound proxy key from the approved runtime topology; Codex credentials remain Gateway environment configuration and are never persisted.
- Kept the stream-first Responses surface and deferred OAuth/device login, refresh-token persistence, account rotation, Chat Completions translation, non-streaming assembly, and WebSocket transport.
- Existing Providers targeting the former Codex Proxy loopback URL require explicit reconfiguration to `codex/responses`; no compatibility alias is provided.

### 2026-09-04 - Gateway Codex OAuth Credentials

- Approved a Gateway-owned Codex CLI-compatible OAuth PKCE login flow with the fixed localhost callback, local single-credential persistence without an additional encryption-key configuration, pre-expiry refresh, per-credential refresh locking, bounded retry, and one forced refresh after an upstream 401.
- Existing Codex records written by the earlier encrypted format are not migrated; those installations must complete OAuth login again after upgrading.
- Kept `CODEX_ACCESS_TOKEN` as an explicit bootstrap fallback while ensuring persisted credentials and refresh tokens never leave the Gateway process or appear in browser/API responses.
- Deferred multi-account rotation, quota scheduling, Chat Completions translation, and WebSocket transport; remote deployments must use a secure port-forwarding path for the registered localhost callback.

### 2026-09-04 - Gateway SQLite Provider Persistence

- Moved Portkey Gateway Provider persistence to an independent SQLite database file and dedicated `gateway_providers` table. The Gateway performs a one-time import from the legacy JSON registry and API `model_providers` table; the API store is no longer a Provider runtime source.
- Removed the separate JSON Provider registry as a runtime data source; existing JSON data is imported once into SQLite when present.
- Kept encrypted Provider credentials and headers in the database storage boundary while API and Agent services access them through Gateway-owned routes.

### 2026-09-04 - Gateway Request Statistics

- Added credential-safe per-request statistics in the Gateway-owned SQLite database and a read-only API query for the Providers page.
- Kept Gateway statistics separate from WorkLite Usage, Runs, Audit Logs, prompts, responses, and secrets; missing upstream token usage is represented as unavailable.

### 2026-09-04 - Provider-Name Model Namespace

- Changed the public OpenAI-compatible model namespace from `<providerId>/<modelId>` to `<providerName>/<modelId>`.
- Kept Provider ids as internal record keys for Agent bindings and administration while resolving public model requests by unique Provider name.
- Defined Provider rename behavior as an immediate namespace change without a compatibility alias for the previous name.

### 2026-09-04 - Sequential Agent Tool Requests

- Disabled provider-level parallel tool calling for OpenAI-compatible Agent model steps while retaining the four-call defensive boundary.
- Added the stable `too_many_tool_calls` execution failure instead of classifying an excessive tool batch as a Provider configuration failure.

### 2026-09-03 - Gateway-Owned Provider Registry

- Moved Provider configuration, credentials, model catalogs, and custom headers to the Portkey Gateway-owned persistent registry.
- Added one-time startup migration of legacy SQLite Provider records into the Gateway registry while preserving Provider ids.
- Kept one protected internal `gateway-provider` binding in WorkLite for Agent and Workflow runtime resolution; it is hidden from Provider APIs, pages, and user configuration.
- Removed public Gateway start, stop, and restart controls. Gateway startup, readiness, shutdown, and unexpected-exit recovery remain API-owned and automatic.
- Removed the previous WorkLite Provider system-of-record contract and the assumption that the Gateway receives decrypted request-scoped Provider credentials.

### 2026-09-02 - Fixed Portkey Gateway Port

- Fixed the API-owned Portkey Gateway listener to loopback port `4547`.
- Removed persisted Gateway port configuration, environment overrides, and the port update API; existing custom values are no longer honored.
- Kept explicit Gateway lifecycle controls and added `4547` to development port cleanup.

### 2026-09-03 - Unified Portkey Gateway Proxy Entry

- Changed the public Gateway proxy from Provider-specific paths to one `/api/portkey-gateway/v1` entry point.
- Namespaced the aggregated model catalog as `<providerId>/<modelId>` so the Gateway can split the requested model and dispatch it to the configured Provider.
- Kept the local API security boundary without a separate Gateway key; the integration surface explicitly communicates that no key is required.

### 2026-09-02 - Local Provider Diagnostic Logs

- Added append-only Provider diagnostic events grouped by a trace identifier for connection-test troubleshooting.
- Persisted ordered lifecycle stages covering Provider resolution, Gateway readiness, upstream transport, and response parsing, with raw local errors and response/request metadata available to the operator.
- Added a dedicated diagnostic logs API and Settings page; connection-test failures return the trace identifier for direct investigation.
- Intentionally limited this capability to the local installation and did not create Run, Artifact, Usage, or Audit records for provider tests.

### 2026-09-01 - Portkey Provider Proxy

- Added a Portkey Gateway sidecar behind the NestJS API for Provider-specific OpenAI-compatible proxy requests.
- Kept WorkLite as the sole owner of Provider configuration, encrypted credentials, model catalogs, and custom headers; Portkey receives request-scoped routing data and does not read the WorkLite database.
- Defined the `/api/portkey-gateway/providers/:providerId/v1` routes for `models`, `chat/completions`, and `responses`, the Provider test route, and the ephemeral `/api/portkey-gateway/model-providers/discover-models` route; Gateway traffic remains separate from Run, WorkLite Usage, Artifact, and Audit persistence while credential-safe request statistics are retained by Gateway.
- Kept the sidecar loopback-only, inherited the API's local security boundary, and intentionally omitted proxy authentication, fallback policy, multi-provider routing, and standalone `local-llm-proxy` compatibility aliases.

### 2026-09-01 - Provider Editing and Gateway Route Ownership

- Added `PATCH /api/model-providers/:providerId` for complete Provider configuration updates by id; the create/upsert route remains `POST /api/model-providers`.
- Kept API keys and custom-header values write-only. An omitted API key preserves the stored key, while an explicit empty header object clears stored headers.
- Standardized every browser-facing request that reaches the Portkey Gateway under the `/api/portkey-gateway` interface prefix and intentionally omitted the previous `/api/proxy` aliases.

### 2026-09-01 - Provider-owned Portkey Gateway Management

- Grouped Model Providers and Portkey Gateway administration under one top-level `Providers` menu while removing Providers from the Agents resource navigation.
- Named the Gateway management API `portkey-gateway` and added persisted port configuration with explicit start, stop, restart, status, and failure reporting controls.
- API startup now starts the Gateway automatically; explicit start, stop, and restart controls remain available, and a stopped Gateway returns a classified `503 Gateway unavailable` response until it is started again.

### 2026-09-01 - Protocol-based Provider Configuration

- Removed the separate Provider vendor type from the approved configuration model.
- Defined user-supplied `baseURL` and namespaced `protocol` values such as `openai/chat` and `openai/responses` as the Provider endpoint contract.
- Kept headers and model catalogs as independent Provider configuration, with the form ordered as name, Base URL, protocol, API key, models, and headers.

### 2026-09-01 - Direct Model Discovery

- Replaced the temporary direct model-discovery route with a Gateway-owned model-list path in the unified Gateway architecture.

### 2026-09-01 - Unified Local Portkey Gateway

- Adopted a pinned local Portkey Gateway workspace package instead of relying on the prebuilt npm sidecar for routing behavior.
- Routed Agent Runtime calls, Provider tests, model discovery, and public Provider proxy traffic through the same Gateway process.
- Limited the local Gateway patch surface to request-scoped Provider routing and reliable `/v1/models` forwarding; upstream updates remain explicit dependency maintenance.
- Added automatic Gateway startup during API initialization and built the local Gateway as an API `dev`/`start` prerequisite.

### 2026-08-31 - React Flow Workflow Canvas

- Restored `@xyflow/react` as the workflow canvas implementation after evaluating the LiteGraph adapter.
- Kept the schema version 3 graph contract, persisted node positions, typed ports, DAG validation, and sequential Workflow Engine unchanged.
- Kept Text editing in React-rendered nodes with the contextual inspector as the keyboard-accessible configuration path.
- Removed the minimap from the workflow editor while retaining palette, inspector, toolbar actions, and responsive drawers.

### 2026-08-31 - Local Development Ports

- Changed the local Vite development port from `5173` to `4536` and the default NestJS API port from `3000` to `4546`.
- Kept same-origin `/api` routing aligned across the Vite development proxy and Nginx upstream configuration without preserving the previous port defaults.

### 2026-08-31 - Composable Generic Agent Workflows

- Upgraded workflow definitions to schema version 3 with named multi-port input assembly and no adapters for earlier schemas.
- Added Workflow Input, Text, Skill Set, and Generic Agent node roles so prompts and authorized Skills are visible graph dependencies.
- Allowed isolated Generic Agent workflow invocations to execute an AgentVersion-authorized subset of Skill scripts through the existing Commands boundary with bounded rounds and cancellation.
- Kept execution sequential and deferred conditions, loops, dynamic joins, parallel scheduling, MCP workflow tools, and immutable SkillVersion persistence.

### 2026-08-31 - Directed Acyclic Workflow Graphs

- Replaced the fixed linear workflow model with schema version 2 directed acyclic dataflow graphs containing persisted node layout and explicit port-to-port edges.
- Selected `@xyflow/react` for the workflow canvas and approved node dragging, edge editing, panning, zooming, fit-to-view, and a minimap.
- Approved single-input data fan-out with deterministic sequential topological execution while deferring conditions, joins, loops, and concurrent branches.
- Intentionally omitted adapters and migrations for schema version 1 workflow definitions.

### 2026-08-30 - Agent resource page tabs

- Replaced the Agents sidebar subgroup with shared page-level tabs for Agents, Skills, MCP servers, and Model Providers while keeping Plugins as a first-level workspace destination.
- Kept all existing routes and persistence unchanged, so no compatibility layer or data migration is required.

### 2026-08-30 - Codex plugin command arguments

- Expanded the persisted Codex command from one executable token to a safely parsed executable plus optional fixed leading arguments, without shell syntax or environment-variable overrides.
- Reused the parsed argument vector for availability probing and execution, while retaining existing `codex` values without migration.

### 2026-08-30 - Resource navigation hierarchy

- Promoted Plugins to a first-level workspace resource alongside Agents and grouped Skills, MCP servers, and Model Providers beneath Agents in the unified sidebar without changing routes, persistence, or API ownership.

### 2026-08-30 - WeChat ClawBot transport

- Added a server-owned iLink text transport for the built-in Codex plugin, with encrypted token persistence, QR login state, cursor recovery, per-user execution mapping, and reconnectable polling.
- Kept Codex command selection in persisted plugin configuration and limited the first transport increment to text messages; media/CDN handling is deferred.

### 2026-08-29 - Runtime Reliability and Dependency Alignment

- Adopted the official MCP TypeScript SDK for remote Streamable HTTP negotiation, discovery, and tool calls, and made endpoint and allowed-tool draft metadata readable without exposing credentials.
- Replaced ad hoc startup schema mutation with checked-in Drizzle migrations and startup migration execution.
- Added restart failure normalization for queued or running Workflow Runs and Node Runs in the API-local executor.
- Removed inactive worker and object-storage deployment claims from the current runtime while retaining them as future scale boundaries.
- Removed unused form and Monaco dependencies from the web baseline, selected CodeMirror 6 only for future concrete editor needs, and added ESLint and Knip to the operations baseline.

### 2026-08-29 - End-to-end Agent and Workflow Runtime

- Approved immutable AgentVersion snapshots as the binding boundary for published workflows.
- Added first-party `worklite/text` and `worklite/agent` execution through the Workflow Engine registry.
- Added persisted NodeRun records, replayable workflow run events, and Artifact references for file outputs.
- Extended the workflow editor contract from Agent-only steps to generic linear nodes while retaining the no-branching model.
- Kept the API-local asynchronous executor and SQLite persistence; durable queues and workflow resume remain deferred.

### 2026-08-29 - Built-in Codex CLI Plugin Runtime

- Approved the product-owned `codex-cli-chat` plugin as a trusted external-process Agent execution backend.
- Reused Agent execution persistence, SSE events, cancellation, and audit records; each turn invokes `codex exec --json` through the Commands process boundary and passes the conversation prompt through stdin.
- Added a protected plugin Agent identity for persistence and a workspace-owned plugin configuration resource with a dedicated list and editor page; plugin code and third-party marketplace behavior remain out of scope.
- Moved the Codex executable command from `CODEX_BIN` environment-variable lookup to the persisted plugin configuration, while retaining the API host's working directory and inherited environment as execution prerequisites; no compatibility route or session-file dependency is introduced.

### 2026-08-29 - WorkLite-Compatible G-Agent Helper Runtime

- Approved a g-agent-style System Helper runtime while retaining WorkLite ownership of Commands, Skills, MCP authorization, persistence, workspace isolation, and audit records.
- Added the target contract for built-in helper tools, multi-round execution, typed clarification, streamed execution events, MCP tool calls, background Agent sessions, and recurring background tasks.
- Defined abort-aware provider/MCP retries, bounded tool rounds, idempotent terminal transitions, restart recovery for all helper side effects, and provider-only context trimming that never deletes display history.
- Kept direct filesystem tools and source-project disk state out of the runtime; built-in host operations continue through the persisted Commands boundary.

### 2026-08-29 - Reconnectable Agent Execution Events

- Approved persisted, sequence-numbered Agent execution events delivered through Server-Sent Events for live model deltas, tool lifecycle, status, and terminal updates.
- Reused the existing Commands SSE connection and replay pattern with `Last-Event-ID`; kept REST execution endpoints as the authoritative mutation and snapshot contract.
- Kept browser disconnects non-cancelling and accepted snapshot-only recovery for pre-existing executions without historical event records.

### 2026-08-29 - Remove Workspace Resolution Compatibility Fallback

- Removed the workspace lookup fallback that silently selected the first database row when the canonical workspace was missing.
- Workspace resolution now uses the requested slug directly and fails with a not-found response when that workspace does not exist.

### 2026-08-28 - Recoverable And Diagnosable Helper Executions

- Extended restart normalization from child sessions to every persisted Agent execution, including the main System Helper conversation.
- Added safe execution phase and error-code metadata, terminal audit records, and server-owned unread updates for completed or recovered sub-sessions.
- Allowed follow-up messages after failed executions while retaining single-turn execution and terminal-state guards.
- Defined browser reconnect behavior and request-generation protection as the presentation layer for the same persisted execution contract.

### 2026-08-28 - Generic Workflow Node Contract

- Generalized Workflow definitions from Agent-only steps to versioned Node Types with explicit configuration, input, and output contracts.
- Kept the first execution strategy linear while separating the Workflow Engine, Node Type registry, plugin composition, and Agent Node adapter.
- Locked Node Type versions alongside referenced Agent, Skill, and MCP versions at publication time.
- Deferred graph control flow, script-authored primary workflows, plugin marketplace behavior, and untrusted in-process plugins.

### 2026-08-29 - Persisted Workflow Drafts And Revisions

- Added a mutable WorkflowDraft with an authoritative current-revision pointer and immutable EditRevision snapshots.
- Defined typed, base-revision-checked draft operations, server-owned undo/redo, and atomic revision application for manual and AI edits.
- Made publication copy the current draft into an immutable WorkflowVersion and restricted runs to explicit published versions.
- Defined the one-time migration from legacy workflow-version node arrays and accepted that browser-only edits cannot be recovered.

### 2026-08-28 - Explicit Mentioned Sub-Agent Sessions

- Added persistent custom-Agent sub-sessions launched by a structured `@` selection in System Helper Chat.
- Kept child Agent configuration, execution history, continuation, cancellation, and model context independent from the main System Helper conversation.
- Defined workspace-scoped sub-session lifecycle APIs and restart normalization for in-memory work that cannot be resumed.

### 2026-08-28 - Mutation Completion And AI Elements UI

- Added durable success and failure handling for provider, MCP, workflow, Agent, and Run mutations, including duplicate-submission protection, query refreshes, and post-delete navigation.
- Added the typed MCP draft update operation used by the configuration editor.
- Adopted compositional AI Elements-compatible Conversation, Message, and Prompt Input primitives for the shell-owned System Helper Chat without changing server execution boundaries.

### 2026-08-27 - Credential-Safe Agent Tool Failures

- Required the model gateway to reject malformed and schema-invalid Skill requests before they enter Agent history.
- Required active Agent turns to fail promptly with an actionable credential-safe error while excluding raw tool input, provider responses, stack traces, and credentials.
- Made committed failures terminal so a later cancellation cannot hide the original cause.

### 2026-08-27 - Uncapped Agent Execution Content

- Removed WorkLite character and count limits from Agent messages and Skill-script string arguments while retaining non-empty and structural validation.
- Removed the Agent model-step output-token cap and forced timeout while preserving explicit cancellation.
- Removed content-length validation for responsibility and system prompt in the platform Agent-creation script.
- Left transport, Model Provider, operating-system, Skill package storage, identifier, path, and structural validation boundaries unchanged.

### 2026-08-27 - Cancellable Background Agent Turns

- Made Agent create and continue endpoints return persisted `running` executions immediately while model and Skill work continues in the API process.
- Added turn-scoped Agent cancellation for active model requests and linked Command executions, with persisted `cancelled` states and guards against late completion writes.
- Kept conversations reusable after cancellation, preserved browser drafts, and intentionally did not introduce a hidden message queue.

### 2026-08-27 - Automatic Assigned-Skill Execution

- Removed per-invocation browser approval from assigned Skill scripts; valid `skill_script` requests now persist and execute immediately on the server before the Agent turn continues.
- Removed the Agent tool-call decision route and the `pending_approval` and `rejected` runtime states without compatibility aliases or migration of unfinished approval sessions.
- Accepted that assigning `terminal-command` lets the configured model execute arbitrary commands immediately with the API process user's complete host permissions.

### 2026-08-27 - Script-Backed WorkLite Platform Skill

- Replaced the System Helper fixed platform-tool registry and browser-owned proposal execution with product-owned `worklite-platform` scripts invoked through generic `skill_script` Agent sessions.
- Required platform scripts to call loopback typed APIs rather than Nest services or SQLite, with server-owned Skill context, validation, settings persistence, and credential boundaries.
- Made Web a renderer and approval client; resource mutations execute on the server, while only allowlisted navigation remains a typed client-actuated result.
- Removed the former System Helper NDJSON proposal protocol and browser proposal compatibility path.

### 2026-08-27 - Script-Backed Built-in Terminal Skill

- Replaced the special `terminal_command` Agent capability with a product-owned `scripts/run.sh` file in the protected `terminal-command` Skill package.
- Required both direct built-in execution and assigned-Agent execution to use the same generic persisted `skill_script` discovery, validation, snapshot, and Commands runtime.
- Removed the former terminal-specific model tool and pending-call compatibility path while retaining existing command execution history.

### 2026-08-27 - Direct Skill Script Execution

- Made saved shebang-bearing files under a user Skill's `scripts/` directory directly executable from the Skill editor without an Agent, model, or separate approval step.
- Kept package validation, persisted snapshots, host execution, output events, and cancellation on the server through the shared Commands runtime.
- Removed the standalone Terminal page and navigation concept; WorkLite does not expose a generic command-composer product surface.

### 2026-08-27 - Server-Owned Host Command Interface

- Added a dedicated Commands domain that persists and asynchronously executes `/bin/sh -lc` commands independently of Web, Model Providers, Agents, Skills, and approval state.
- Required `process.cwd()`, the complete API process environment, API-user host permissions, uncapped output persistence, reconnectable SSE observation, and process-group cancellation without a sandbox or forced timeout.
- Made Agent terminal and executable Skill integrations delegate spawning to Commands while retaining their own optional review workflow.
- Made loopback binding the default and required explicit `API_HOST` configuration to expose the unrestricted command API on another interface.

### 2026-08-27 - Executable User Skill Packages

- Expanded online user Skills from a single instruction field to canonical persisted `SKILL.md`, `scripts/`, and textual `references/` package files.
- Added assigned-Skill script discovery and a model-requested `skill_script` tool constrained to an exact Skill, snapshotted script, and argument array.
- Accepted first-stage direct Unix host execution from a temporary package root without a sandbox, while retaining per-call approval, bounded environment, timeout, capped output, process-group termination, cleanup, and auditing.
- Generalized Agent approval records and the public decision endpoint from terminal-only calls to terminal-command and Skill-script tool calls, intentionally without a compatibility alias.

### 2026-08-27 - Real Skill Package Details

- Replaced browser-owned example package files with an API-provided package-file contract backed by persisted Skill instructions.
- Limited the current online package to its real `SKILL.md` and prohibited invented `scripts/`, references, validation, publication, or archive-upload behavior.
- Added real name and `SKILL.md` updates for user Skills while keeping protected built-ins read-only in the same package layout.

### 2026-08-26 - Protected WorkLite Platform Skill

- Added `worklite-platform` as a protected built-in Skill permanently assigned only to Chat.
- Replaced browser text heuristics with model-requested, server-validated platform actions for constrained navigation, resource-draft creation, and confirmed appearance or language changes.
- Required explicit confirmation for every mutation, retained secure forms for secrets, and excluded arbitrary URLs, APIs, database access, deletion, unrestricted updates, terminal execution, and custom-Agent assignment.

### 2026-08-26 - Zero-Configuration Host Terminal Execution

- Removed the host-terminal enable flag, configured working directory, and configured executable path from the first-stage runtime.
- Made the built-in terminal capability automatically available on Unix-like hosts, with `process.cwd()` and the API process `PATH` defining command startup behavior.
- Accepted the absence of a global disable switch while retaining explicit per-Agent assignment, per-command browser approval, bounded execution, capped output, process-group termination, and Windows unavailability.

### 2026-08-26 - Approved Host Terminal Skill

- Added the protected `terminal-command` Skill as the only first-stage executable Skill capability and required explicit per-Agent assignment.
- Initially accepted opt-in Unix host execution through `/bin/sh -lc`; the later zero-configuration decision above supersedes its enable flag and path settings while retaining the same host-permission warning.
- Required every model-requested command to persist and pause for explicit browser approval before execution, with durable audit metadata and credential-free child environments.
- Added server-owned custom Agent execution sessions for real model text and approved terminal tool calls while keeping Agent publication, Workflow integration, user-created executable Skills, Windows support, and sandboxing deferred.

### 2026-08-26 - Persisted Agent Draft Configuration

- Made Provider/Model, system prompt, Skill assignments, and MCP server assignments explicit persisted fields of each custom Agent draft.
- Added relational per-Agent Skill and MCP bindings with same-workspace validation; workspace resources remain reusable but are never assigned globally.
- Removed unsupported Agent preview, publication, version, and execution-status presentation until their runtime and immutable-version boundaries are implemented end to end.
- Intentionally did not migrate the legacy Agent `skills` JSON placeholder; existing Agents begin with no persisted Skill or MCP assignments.

### 2026-08-26 - Grounded System Helper Chat Inventory

- Added a credential-safe workspace resource snapshot to each System Helper Chat model request so inventory answers use current persisted platform data.
- Kept provider and MCP secrets outside model context and exposed only the stored MCP allowed-tool count until discovered tool names are persisted.
- Changed `/log` from appending a generated assistant message to downloading a local Markdown transcript.

### 2026-08-26 - Agent Chat Message Queue

- Added a browser-lifetime FIFO queue so messages can be submitted during an active model response.
- Kept model execution sequential, rebuilt history when each queued turn starts, and paused later turns after a failed response until retry succeeds.
- Allowed queued turns to be removed before execution without introducing persistence or a server-side queue.

### 2026-08-26 - System Helper Chat Identity And Model Binding

- Renamed the protected system Agent to System Helper Chat and assigned the stable identifier `agt_system_helper_chat` without a compatibility alias for the previous identifier.
- Added an explicit model selection bound to the selected provider's configured model catalog and made runtime execution use that saved model.
- Added a breadcrumb-leading back action to Agent editor pages.

### 2026-08-26 - Executable System Helper Chat Operations

- Added local intent routing for known workspace pages without allowing arbitrary navigation targets.
- Changed confirmed Agent, Skill, and MCP proposals to call their typed creation APIs and expose created-resource links.
- Allowed Provider proposals to save non-secret configuration only, then direct the user to the secure Provider form for credentials.
- Kept operation state browser-local and required explicit confirmation before every mutation.

### 2026-08-26 - Streaming Agent Responses

- Replaced Agent Chat's complete JSON response with a normalized NDJSON event stream backed by the model gateway text stream.
- Kept pre-stream validation as ordinary HTTP errors and moved post-header failures into credential-safe stream events.
- Assigned incremental message assembly to the browser without adding conversation persistence or a compatibility response shape.

### 2026-08-26 - Model-backed Agent Chat

- Connected the protected Agent Chat binding to real AI SDK execution through the WorkLite model gateway.
- Selected the bound provider's first configured model and kept the product-owned system prompt on the server.
- Kept conversations browser-lifetime and non-persistent while retaining the existing local proposal and simulated application behavior.
- Replaced the unconfigured composer with a direct link to the Agent Chat provider-binding form.

### 2026-08-26 - Protected Agent Chat Configuration

- Added Agent Chat as a startup-created system Agent with a stable identifier and first position in the Agent list.
- Made the system Agent non-deletable and limited its editable configuration to one nullable Model Provider binding.
- Assigned provider binding ownership exclusively to the Agent Chat editor and required provider deletion to clear the binding.
- Kept the current browser-local Chat behavior unchanged; the binding is reserved for the separately approved model-backed assistant increment.

### 2026-08-26 - Real Model Provider Smoke Test

- Replaced the browser-only simulated provider test with a real AI SDK request through the WorkLite model gateway.
- Standardized the smoke test on the first configured model, fixed prompt `你好`, bounded output, and a 30-second timeout.
- Kept test prompts and responses ephemeral and required credential-safe failure messages.

### 2026-08-25 - AI SDK Provider Configuration

- Aligned model-provider configuration with the installed AI SDK factories for DeepSeek, OpenAI, and OpenAI-compatible endpoints.
- Added optional base URL, OpenAI organization/project, model catalog, and write-only custom headers.
- Encrypt custom headers at rest and return only their names/count in API views; omitted headers preserve existing values and `{}` clears them.
- Kept provider-specific generation options in the Agent Runtime boundary rather than expanding the provider persistence contract.

### 2026-08-25 - Single-User Personal Workspace

- Replaced team tenancy, accounts, memberships, invitations, and authentication with one installation-owned workspace.
- Flattened the public route and API shape so resources no longer require a team slug or session cookie.
- Kept SQLite persistence, immutable versions, asynchronous runs, assistant proposals, provider/MCP secret handling, and audit history.
- Intentionally removed the old team and authentication routes without redirects or aliases; the product is now suitable for local or trusted self-hosted use only.

### 2026-08-25 - Email-First Authentication

- Approved automatic email-status lookup on `/login` before revealing password or account-creation fields.
- Added the typed API boundary for registered versus unregistered email state without returning user details.
- Accepted the account-enumeration signal for this flow and required uniform timing plus future rate limiting controls.

### 2026-08-25 - Unified Authentication Entry

- Consolidated sign-in and account creation into the `/login` route with router-owned mode state.
- Required successful authentication to consume a saved same-origin destination before using the normal verification, onboarding, and workspace fallback sequence.
- Intentionally removed the former `/sign-in` and `/sign-up` routes without compatibility aliases.

### 2026-08-25 - Real API Integration

- Approved replacing browser mock data with a same-origin, typed REST API backed by PostgreSQL.
- Added the first vertical slice for development sessions, team-scoped Agents and Workflows, and asynchronous Workflow Runs through Redis/BullMQ.
- Kept controllers, persistence, queue execution, and browser data access in their existing application/package boundaries.
- Intentionally did not preserve mock-only routes or add compatibility aliases; production identity-provider authentication remains a later increment.

### 2026-08-25 - Real API Resource Completion

- Approved extending the same REST, PostgreSQL, and TanStack Query boundary to Skills, MCP Servers, Model Providers, Artifacts, Members, Usage, Audit Logs, and invitation lookup.
- Kept provider and MCP secrets write-only, retained object storage for future binary and large payloads, and made audit records append-only.
- Intentionally deferred third-party identity providers, arbitrary MCP `stdio`, binary archive processing, and mock compatibility aliases.

### 2026-08-25 - Lightweight Local Runtime

- Replaced the initial local PostgreSQL persistence target with a file-backed SQLite database managed by Drizzle.
- Replaced Redis/BullMQ and mandatory worker execution with an API-local asynchronous run executor.
- Kept the typed REST boundary and service ownership intact so a later production increment can restore PostgreSQL and a durable worker queue.
- Accepted single-process limits while retaining persistence across API restarts and deferring multi-instance execution.

### 2026-08-25 - Model Provider Lifecycle

- Added explicit create and delete operations for workspace-scoped Model Providers alongside the existing list and upsert operations.
- Kept provider credentials write-only, workspace-filtered, and outside browser state; deletion requires an explicit confirmation in the UI.
- Kept the change inside the existing resource service and REST boundary without introducing a new domain or compatibility route.

### 2026-08-24 - AI SDK Model Gateway

- Added a WorkLite-owned provider-neutral `model-gateway` boundary between agent execution and model SDKs.
- Selected AI SDK as the initial implementation layer for DeepSeek, OpenAI-compatible, and future model providers.
- Kept tenancy, secret handling, persistence, usage accounting, retries, authorization, and sandbox policy outside AI SDK.
- Deferred DeepSeek Harness integration to an optional future Agent Runtime adapter rather than making it a core dependency.

### 2026-08-24 - Agent Resource Provider Placement

- Returned Model Providers to the Agent resource surface as the final page-level view after MCP Servers.
- Kept Model Providers team-scoped in the domain model and retained the dedicated `/:teamSlug/model-providers` route.
- Did not restore the previous Settings route or add a compatibility redirect.

### 2026-08-24 - Team-level Model Providers

- Made Model Providers a first-class team-scoped resource independent of Agents.
- Removed the provider resource from the Agent navigation surface and defined a dedicated workspace route.
- Intentionally did not preserve the previous settings-path route or add a compatibility redirect.

### 2026-08-20 - Workspace Assistant

- Approved a team-scoped workspace assistant for provider setup and structured Skill, MCP server, and Agent creation.
- Required explicit review and confirmation before applying assistant operations through existing domain services.
- Excluded secrets from assistant conversations and retained existing validation, authorization, publication, and audit boundaries.
- Allowed an initial local UI prototype before persistent sessions and model-backed server execution are introduced.

### 2026-08-14 - Internationalization Standard

- Established English and Simplified Chinese as the initial application locales, with English as the fallback.
- Kept authenticated workspace routes locale-neutral and defined locale as a personal preference.
- Required machine-readable API values and presentation-boundary localization.
- Added the fixed Chinese-only Web interface contract; the former multi-locale design is retained only as historical context.

### 2026-08-13 - Initial Architecture Baseline

- Established WorkLite as a team-oriented agent and workflow platform.
- Selected a browser/server TypeScript monorepo architecture.
- Selected React, Vite, TanStack Router, TanStack Query, and Zustand for the web application.
- Selected NestJS for the API and standalone worker.
- Selected PostgreSQL with Drizzle ORM as the primary persistence layer.
- Selected Redis and BullMQ for asynchronous execution.
- Selected S3-compatible object storage for skills, attachments, and artifacts.
- Defined team-scoped Agent, Skill, MCP, Workflow, and Run resources with immutable published versions.
- Limited the initial workflow model to ordered agent nodes.
- Defined structured AI workflow edits with authoritative revisions and undo/redo support.
- Defined asynchronous execution, Server-Sent Events progress, and initial runtime safety boundaries.
