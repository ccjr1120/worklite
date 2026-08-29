# Project Architecture

## Status and Governance

This document is the source of truth for the WorkLite architecture. Architecture changes must follow the `Project Architecture Change Workflow` in `AGENTS_WORKFLOW.md`: discuss the change with the user, obtain explicit confirmation, update this document and its changelog, and only then implement the approved design.

This is the approved initial baseline. Target-state components may be introduced incrementally.

## Product Overview

WorkLite is a single-user personal tool for creating and running AI agents and workflows. One local workspace manages model providers, agents, skills, MCP servers, workflows, runs, and artifacts.

Agents are configured manually with their own prompts, model settings, skills, and MCP access. Users compose existing agents into workflows. A workflow can be edited with explicit add-node controls or through a natural-language AI assistant. Every AI change is recorded and reversible, similar to an AI-assisted code editor.

The workspace assistant can also inspect the workspace and create Provider, Skill, MCP server, Agent, and Workflow drafts through assigned Skill scripts. Every script request is explicit, executes automatically after server validation, and remains subject to the same validation, secret-handling, publication, and audit rules as manual configuration.

## Architectural Principles

1. Use a browser/server architecture with a separately deployable web application and API; durable worker execution is a later scale-out boundary.
2. Keep applications and shared packages in a TypeScript monorepo.
3. Use one installation-owned workspace as the resource-isolation boundary.
4. Keep published versions immutable and bind runs to explicit versions.
5. Start with linear workflows instead of a general graph engine.
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
                  |-- Host command executor
                  |-- In-process run executor
                  |     |-- Model providers
                  |     |-- MCP servers
                  |     `-- Skill and Agent execution
                  `-- S3-compatible object storage

Browser <---- Server-Sent Events ---- API
```

The web application is delivered as static assets and is only an HTTP and Server-Sent Events client. The API owns domain operations, command execution, workflow revisions, run creation, and progress delivery. The local installation is intentionally single-user and has no account or authorization boundary. Command and workflow execution continue independently of browser connections.

## Technology Baseline

### Monorepo

- pnpm workspaces for dependency and workspace management.
- Turborepo for task orchestration and caching.
- TypeScript across the web, API, worker, and shared packages.

### Web Application

- React with Vite.
- TanStack Router with file-based, type-safe routing.
- TanStack Query for server state and caching.
- Zustand for transient editor state and local undo/redo.
- React Hook Form and Zod for forms and runtime validation.
- Tailwind CSS and shadcn/ui for the UI system.
- Monaco Editor for prompts, skills, and structured configuration where appropriate.
- Server-Sent Events for workflow-run progress.
- i18next with react-i18next for application internationalization.

TanStack Router owns URL and navigation state. TanStack Query owns remote server state. Zustand owns uncommitted editor state. Backend authorization remains authoritative.

The personal installation has no public sign-in, account creation, email verification, invitation, or password recovery flow. The root route opens Home directly and the API accepts requests without a session cookie. This is intentional for local use. Because the API includes unrestricted host command execution, it binds to `127.0.0.1` by default; listening on another interface requires an explicit `API_HOST` value and transfers responsibility for network access control to the operator.

Authenticated workspace routes do not include a locale segment. The web application resolves and persists a personal locale preference, falls back to English, and translates product-owned presentation content at the UI boundary. API contracts, persisted domain values, identifiers, logs, and externally supplied content remain language-neutral. `docs/internationalization/README.md` is the source of truth for internationalization requirements.

### API and Execution

- NestJS for the HTTP API.
- An optional separately deployed NestJS worker reserved for a later production scale-out increment.
- REST for configuration and command APIs.
- Server-Sent Events for one-way progress delivery.
- An in-process asynchronous executor for the initial local runtime. A durable queue is a later production scale-out boundary.

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

- WorkLite owns a provider-neutral `model-gateway` package between agent execution and model-provider SDKs.
- AI SDK is the initial provider integration layer. The gateway may use `@ai-sdk/deepseek`, `@ai-sdk/openai`, and other provider packages without exposing AI SDK types in domain contracts or persistence models.
- The gateway resolves workspace-scoped provider configuration and secrets, creates model handles, streams normalized model output, and reports provider-neutral usage and failures to the agent runtime.
- AI SDK does not own WorkLite tenancy, credentials, workflow persistence, queues, audit records, quotas, or sandbox policy. Those remain WorkLite responsibilities.
- DeepSeek Harness is not a core runtime dependency. A future adapter may use it for DeepSeek-native Agent execution, but the initial Agent Runtime and Workflow Engine depend only on the WorkLite gateway contract.

### Persistence

- SQLite as the initial local system of record, stored in a project data directory.
- Drizzle ORM for schemas, migrations, and type-safe queries.
- PostgreSQL, Redis, and BullMQ are deferred until multi-instance execution and durable queue requirements justify them.
- S3-compatible object storage for skill archives, attachments, large outputs, and artifacts.

Core relationships use relational tables. Versioned workflow definitions and revision operations may use SQLite JSON columns. Binary files and large payloads belong in object storage; SQLite stores metadata and object keys.

### Operations

- OpenTelemetry for traces and metrics.
- Sentry for error reporting.
- Vitest for unit and integration tests.
- Playwright for browser end-to-end tests.
- Docker Compose for the initial local and self-hosted environment.

## Domain Model and Ownership

```text
Workspace (one per installation)
|-- ModelProvider
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
        `-- ordered WorkflowNode references NodeTypeVersion
            `-- WorkflowRun
                `-- NodeRun
```

All workspace-owned records include `workspace_id`. The API resolves the singleton workspace by the requested canonical workspace slug and applies workspace filtering to every resource query. A missing slug is an error; the API never substitutes another workspace. There are no accounts, memberships, invitations, roles, or authorization checks in this product shape.

## Agent Architecture

An agent is manually configured with a name, description, optional avatar, model selected from the workspace's configured model providers, system prompt, skills, MCP access, and supported runtime settings. Skill and MCP definitions remain reusable workspace resources, but their assignment is explicit and independent for every Agent. Creating or editing one Agent never grants those resources to another Agent. The API validates that every selected provider, Skill, and MCP server belongs to the same workspace.

The initial Agent configuration increment persists mutable Agent drafts. `agent_skills` and `agent_mcp_servers` relational tables own the many-to-many draft assignments; the Agent row owns its provider, model, and system prompt. The draft editor exposes only real persisted behavior. Preview, publication, version labels, and execution status are not exposed until immutable AgentVersion creation and Agent execution are implemented end to end. Agent versions remain the target immutable publication boundary.

The singleton workspace owns one protected system Agent with the stable identifier `agt_system_helper_chat`. It represents the product's System Helper Chat and is created during startup bootstrap. It always appears before custom Agents, cannot be deleted, and exposes a nullable Model Provider binding plus a model selection for user configuration. Its name, responsibility, prompt, Skills, and MCP configuration are product-owned and read-only. Startup permanently assigns the protected `worklite-platform` Skill and repairs that assignment if local data is changed; the Skill cannot be assigned to a custom Agent. The binding and model can be changed only from the System Helper Chat entry in the Agent editor; provider pages and the Chat surface do not own configuration selectors. The selected model must belong to the selected provider's configured model catalog. Changing or deleting a provider clears the binding when necessary and resets an invalid model selection to an unconfigured state. When configured, System Helper Chat resolves the bound provider and selected model through the WorkLite model gateway. When unconfigured, ordinary System Helper submission is unavailable; the surface links to the protected Agent's configuration form unless a configured custom Agent keeps the composer available for structured `@` dispatch.

Workflow nodes are generic typed execution units. Each node references a registered Node Type and contains versioned configuration plus explicit input and output mappings. The initial editor exposes one default `input` and `output` port per node, while the contract reserves named ports for later graph capabilities. A Node Type declares configuration, input, and output schemas and executes behind the Workflow Engine contract.

Plugins are the extension and composition boundary. A trusted in-process plugin may register Node Types, runtime capabilities, typed lifecycle events, and optional browser metadata. The Workflow Engine does not import concrete plugin implementations; it resolves a Node Type from its registry and invokes its execution contract. Plugin registration is separate from node execution: a plugin may contribute capabilities without being a workflow node.

Agent is one Node Type rather than the Workflow Engine's universal primitive. The Agent Node adapter references an immutable AgentVersion, maps workflow input into the Agent Runtime request, and returns text, structured data, and artifact references through the generic node result. Agent Runtime remains independent from Workflow Engine.

A published workflow locks every referenced `AgentVersion`; later agent edits cannot alter published workflows or historical runs. Deleted referenced agents use soft deletion so historical versions remain executable and auditable.

Model providers are workspace-scoped resources and are presented in the Agent resource surface for workspace navigation. Agents may reference models exposed by a provider belonging to the same workspace. Provider configuration follows the installed AI SDK factories: `deepseek`, `openai`, or `openai-compatible`, with an optional base URL, API key, model catalog, and provider-specific OpenAI organization/project values. Custom request headers are accepted as a JSON object, encrypted at rest with the same secret-storage boundary as API keys, and passed to the gateway without exposing their values. API responses return only header names and counts. Provider credentials remain write-only and provider changes do not mutate immutable published workflow versions.

Provider connection tests are synchronous, bounded smoke tests through the same model gateway used by runtime execution. `POST /model-providers/:providerId/test` loads the stored provider configuration, selects the first configured model, sends the fixed prompt `你好`, limits output, and times out after 30 seconds. The result is returned directly to the requesting browser and is not persisted as a Run, Artifact, conversation, or audit payload. Test failures expose only a classified, credential-safe message and never include provider secrets, custom-header values, or raw upstream response bodies.

## Workspace Assistant Architecture

The workspace assistant is the normal server-owned Agent execution surface for the protected `agt_system_helper_chat` Agent. It supplements the resource editors rather than replacing them and uses the same model step, persisted messages, Skill discovery, automatic tool execution, execution result, and continuation contracts as other Agents. Its runtime follows the g-agent interaction model while keeping WorkLite ownership of persistence, Commands, Skills, MCP authorization, and audit records.

System Helper Chat permanently owns the protected `worklite-platform` Skill. That Skill is a standard immutable package containing `SKILL.md`, executable Node scripts under `scripts/`, and a contract reference. It receives no capability flag and does not enable a fixed model-tool registry. The model can request only exact scripts discovered from the persisted package; every requested script is snapshotted into the Agent tool-call record and starts automatically after server validation.

Platform scripts run as child processes through the shared Skill and Commands runtime. They never import Nest services or access SQLite directly. The API process exposes its loopback base URL and workspace slug to every Skill invocation as server-owned context. `worklite-platform` scripts use the built-in Node `fetch` API to call the same typed resource and settings endpoints used by manual forms. This preserves server validation, domain ownership, audit behavior, and independence from the Web client. The scripts accept one JSON argument, validate their operation-specific structure, and print one JSON result containing the affected resource and route. The Agent creation script forwards complete responsibility and system-prompt strings without application-level character limits.

Initial scripts inspect the credential-safe workspace snapshot; create non-secret Provider, Agent, Skill, MCP server, and Workflow drafts; update persisted appearance or language settings; and validate a requested navigation target. Provider credentials and custom-header values are never accepted by the scripts, model context, Agent tool-call arguments, ordinary logs, or errors. A created Provider result directs the user to the secure Provider form for credentials.

Navigation is the only client-actuated result because a server process cannot move a browser. The navigation script calls a server allowlist endpoint and returns a typed client action containing the resolved route. Agent execution stores this parsed action with the completed tool call. Web may apply only that server-returned action and must not infer navigation or operations from model text or raw stdout. Appearance and language are persisted server settings; Web reads and applies the resulting state instead of owning the mutation.

System Helper conversations are persisted as ordinary mutable Agent executions, not Runs or Artifacts. The browser stores only the current execution identifier and optional local archive labels needed by `/new`, `/resume`, and `/log`; it does not own messages, operation ordering, cancellation state, or mutation state. Creating or continuing an Agent execution persists the complete non-empty user message without application-level character or per-execution message-count limits, schedules the turn in the API process, and returns the `running` execution immediately. Agent model steps do not impose a WorkLite output-token cap or forced timeout and remain cancellable through the normal turn-cancellation route. Transport request-size limits and the selected Model Provider's context and generation boundaries remain authoritative external constraints, so accepted long messages may still fail during provider execution. A new message may be submitted after the current turn reaches `completed`, `cancelled`, or `failed`; a failed execution clears its error when a follow-up starts. A `skill_script` request keeps the execution `running`, starts the validated script immediately, and returns its result to the same model turn before another tool request or final response.

System Helper Chat also supports explicit custom-Agent dispatch through a structured `@` selection and helper-created background sessions. Web sends the selected Agent identifier and the remaining non-empty task as separate request fields; ordinary message text is never parsed as a dispatch command, and the task is never submitted to the System Helper model. Only one custom Agent may be selected for a task. The target Agent must belong to the current workspace, must not be protected, and must have a configured Provider and model. It executes with its own prompt, Provider, model, Skill assignments, MCP assignments, and conversation history. A helper-created session uses the same persisted sub-session contract and never enters the main conversation context.

Each dispatch creates an `agent_sub_sessions` row linked to one ordinary mutable Agent execution. The sub-session stores workspace and Agent ownership, a display title, unread state, and timestamps; messages and execution lifecycle remain owned by the linked execution. `GET /agent-sub-sessions`, `POST /agent-sub-sessions`, `PATCH /agent-sub-sessions/:sessionId`, and `DELETE /agent-sub-sessions/:sessionId` list, create, update unread state, and delete these records within the active workspace. Deleting a sub-session cancels an active turn before deleting the linked execution and its dependent tool calls. Sub-session turns run independently of the main System Helper execution, remain available after browser reload, accept follow-up through the existing execution continuation route, and never enter the main conversation or model context. `/new` changes only the main System Helper conversation.

The API process owns in-memory scheduling and cancellation handles, so an interrupted process cannot resume a previously running turn. Database initialization changes every persisted `running` execution to `failed` with a stable restart-safe error while preserving its messages. Running Skill calls, MCP calls, and built-in host calls are also marked failed, and linked sub-sessions become unread so the restart is visible after reload. Execution views persist a safe diagnostic phase and error code alongside the safe localized error message; terminal transitions write audit metadata containing the execution, tool-call, command-execution, and background-task identifiers without provider responses, stack traces, credentials, or raw SDK errors. This normalization is a forward runtime rule for existing records; no compatibility route, text command, or migration adapter is provided.

Agent execution progress is delivered through a reconnectable Server-Sent Events endpoint at `GET /agents/:agentId/executions/:executionId/events`. Agent events are persisted with monotonically increasing execution-local sequence numbers and replayed from `Last-Event-ID`; a new stream begins with the current safe execution snapshot, followed by live model text deltas, tool lifecycle events, and terminal status events. Existing create, continue, answer, retry, cancel, and execution-read REST endpoints remain authoritative for commands and snapshots. Browser disconnection never cancels execution. Existing executions without event history receive a snapshot on first connection; future events are recorded without reconstructing historical token deltas.

The model gateway exposes a typed built-in tool set (`bash`, `read`, `write`, `glob`, `grep`, `update_plan`, and `ask_user`) only to System Helper Chat, plus the exact executable Skill and authorized MCP tool allowlists for every Agent. Built-in host operations still delegate to Commands and are persisted as tool calls; they do not bypass workspace or audit ownership. `update_plan` is persisted execution state. `ask_user` is available only in the dedicated clarification pass for a newly created multi-step plan, pauses the execution, and resumes it through a typed answer route. The gateway rejects invalid or incomplete tool calls before their response messages enter Agent history, classifies malformed JSON separately from other schema-invalid requests, and exposes only stable credential-safe errors. The Agent runtime immediately marks the active turn `failed` or `waiting_for_input` and persists an actionable safe error message with a phase and error code; it never persists malformed tool input, SDK exceptions, provider response bodies, stack traces, credentials, or meaningless residual model text as a display message. A failure already committed for the turn is terminal and cannot later be replaced by cancellation. A single execution may have only one scheduled advance at a time, and every asynchronous continuation rechecks the persisted state before writing.

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

The protected built-in Skill `worklite-platform`, with the stable identifier `sk_worklite_platform`, is a standard executable Skill package and the only Skill permanently assigned to System Helper Chat. Startup replaces its complete product-owned package, repairs its fixed assignment, and removes assignments to custom Agents. It cannot be edited, deleted, published, uploaded, or manually assigned. Its execution authorization comes only from persisted shebang-bearing scripts and the generic assigned-Skill allowlist.

The package supports credential-safe workspace inspection, constrained navigation, creation of Model Provider, Agent, Skill, MCP server, and Workflow drafts, and persisted appearance or language changes. Resource scripts reuse normal typed domain APIs through the loopback server. The package does not expose arbitrary external URLs, direct database access, resource deletion, unrestricted update operations, terminal execution, credentials, or assignment management.

The protected built-in Skill `terminal-command`, with the stable identifier `sk_terminal_command`, is a standard executable Skill package containing product-owned `SKILL.md` and `scripts/run.sh` files. The script accepts exactly one non-empty command string and delegates it to `/bin/sh -lc`. Startup replaces the complete built-in package with the product-owned files, so it cannot acquire editable behavior while remaining visible and directly executable in the Skill editor.

Assigning `terminal-command` to a custom Agent grants no special capability flag or model tool. The generic executable-Skill discovery finds `scripts/run.sh`, adds that exact script to the Agent's `skill_script` allowlist, and lets the model supply the command as the script's single argument. A valid request executes immediately with the API process user's unrestricted host permissions. Direct execution from the Skill editor follows the same server runtime after the user clicks `Run`.

The Commands module uses the API process's current working directory and complete environment, persists uncapped stdout and stderr events, and provides process-group cancellation. Agent tool-call records link each validated invocation to the resulting command execution. A command can access and return any host data available to the WorkLite process user, including inherited environment values.

Agent execution uses a server-owned session for custom and protected system Agents. The browser sends user messages, the API resolves the saved Agent, its assigned Skill instructions and executable Skill scripts, and the model gateway returns normalized text and tool-call steps. A valid `skill_script` tool call is persisted as `running`, delegated once to Commands immediately, and linked to the created Command before waiting for completion. If the turn remains active, the matching result resumes the same Agent turn and another tool request may then execute through the same sequence. Agent executions and tool calls use `running`, `completed`, `failed`, and `cancelled` runtime states and are mutable runtime records rather than immutable AgentVersions or WorkflowRuns. In-memory abort controllers coordinate active model cancellation in the initial single-process runtime; persisted state remains authoritative and every asynchronous continuation rechecks it before writing. There is no public Agent tool-call decision route. The former approval route, `pending_approval` and `rejected` states, `terminal_command` model tool, System Helper proposal stream, and pending-call behavior are removed without aliases or adapters; existing pending approval sessions are not migrated and must be replaced with new executions. Existing command execution history remains ordinary Commands data. Preview, Agent publication, and Workflow integration remain deferred.

## MCP Architecture

MCP servers are workspace-scoped and versioned. The initial implementation prioritizes remote Streamable HTTP connections. Arbitrary user-supplied `stdio` processes are deferred because they require stronger isolation and operational controls.

The configuration flow is:

1. Enter endpoint and authentication configuration.
2. Test the connection on the server.
3. Discover available tools.
4. Select the tools agents may use.
5. Publish an immutable MCP version.

The initial web configuration also exposes a workspace-scoped update operation for an existing draft. It replaces name, endpoint, and optionally the write-only authentication token before the next connection test or publication.

Secrets use a secret-storage abstraction and must never be returned in full or written to ordinary logs. MCP output is untrusted input. Tool calls must be authorized and auditable.

Assigned MCP tools are resolved lazily when an Agent turn starts and are exposed to the model alongside built-in and executable Skill tools. The runtime records the server, tool name, sanitized arguments, result status, and cancellation state in the same Agent tool-call table. Connection failures are classified without persisting upstream response bodies. A disconnected MCP client is re-created for the next turn; an in-flight request is aborted on turn cancellation and never resumes a model step after the execution has become terminal.

## Workflow Architecture

### Initial Workflow Model

The initial workflow is a fixed, ordered list of generic nodes. It does not support arbitrary edges, branching, loops, parallel execution, or backward jumps. The linear scheduler is intentionally retained while the node contract is generalized.

Each node has a stable identifier, integer position, Node Type identifier and version, JSON configuration, explicit input mapping, and an error policy initially limited to `stop` or `retry`. A node receives the mapped workflow data and execution context. Its committed output becomes the next node's mapped input. Large values are represented by Artifact references rather than copied into every node record.

The first-party `worklite/agent` Node Type adapts an AgentVersion. Other first-party Node Types may later adapt Skills, Commands, HTTP/MCP calls, transforms, approvals, and subworkflows without changing the Workflow Engine contract. Control-flow nodes remain engine-owned until branching and parallel semantics are approved.

Every workflow definition includes a `schemaVersion` for future migrations.

### Editing and AI Assistance

The editor is structured and does not use drag-and-drop. Users add nodes with explicit controls. A side-panel AI assistant can modify the workflow from natural-language instructions.

AI edits are validated structured operations: add, delete, update, or reorder a node. The AI cannot write arbitrary workflow state directly. The server validates and atomically applies operations.

Every manual or AI edit creates an `EditRevision` with its actor, optional source instruction, operations, resulting snapshot or snapshot reference, and timestamp. The initial strategy uses immutable snapshots and a current-revision pointer. This favors reliable undo, redo, refresh recovery, and cross-device recovery. Zustand may provide immediate local history, but server revisions are authoritative.

### Drafts and Published Versions

```text
WorkflowDraft --publish--> immutable WorkflowVersion --run--> WorkflowRun
```

Drafts can change. Published versions cannot. Publication resolves and locks Node Type versions and all referenced resource versions, including AgentVersion, SkillVersion, and MCPVersion where applicable. Every execution is tied to one immutable workflow version.

## Runtime Architecture

Runs are asynchronous because they may take minutes or longer. The initial local runtime schedules execution in the API process so HTTP requests return immediately:

```text
Create run
  -> persist WorkflowRun
  -> schedule in-process job
  -> resolve and execute nodes in order through the Node Type registry
  -> persist NodeRun and events
  -> publish progress
  -> persist final output or failure
```

The API returns a `runId` immediately. The browser loads run state through the API and subscribes to Server-Sent Events. Reconnecting with the same `runId` restores current state and continues event delivery.

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
                  -> timed_out
```

A `WorkflowRun` stores its workspace, workflow version, input, current node, timestamps, final result, and status. A `NodeRun` stores its Node Type identity, configuration snapshot, mapped input, committed output or Artifact references, status, duration, retry count, and plugin-specific execution references. Run progress uses generic node lifecycle events; plugin-specific events are namespaced and carry immutable data snapshots.

Runtime requirements include node and workflow timeouts, cooperative cancellation, worker heartbeats or leases, persisted intermediate results, classified transient retries, idempotency for retryable external side effects, and per-workspace concurrency, duration, and model-usage quotas.

Resume from a failed node is deferred, but completed node runs must be retained. The API-local executor is the initial execution engine. A durable queue such as BullMQ should only be introduced after requirements include multi-instance execution, long waits, human approval, complex branching, or stronger durable-execution semantics.

Initial run endpoints are:

```text
POST /workflow-versions/:workflowVersionId/runs
GET  /runs/:runId
GET  /runs/:runId/events
POST /runs/:runId/cancel
```

Production uses a same-origin `/api` route through the reverse proxy to simplify CORS and Server-Sent Events delivery.

## Real API Integration Increment

The first production-facing API increment replaces browser-only mock data with a same-origin REST API backed by SQLite. The web application uses one typed API client and TanStack Query for remote state; resource pages do not import mock domain records at runtime.

The initial vertical slice includes:

- singleton workspace loading without an account or sign-in flow;
- workspace-owned Agent and Workflow reads and writes;
- asynchronous Workflow Run creation and status reads through the API-local executor;
- shared request and response contracts in `packages/contracts`.

Drizzle owns the SQLite schema. The initial increment uses an idempotent startup bootstrap for local development; a versioned migration runner remains the next database-operations step. API controllers remain thin and delegate persistence to module services. The API schedules run execution in-process and persists run state transitions. Startup creates the singleton personal workspace, the protected System Helper Chat system Agent, and protected built-in Skills; all other resource records are user-created.

This increment intentionally does not add compatibility routes for the previous mock-only behavior, arbitrary graph workflows, or account-based identity integration.

## Real API Resource Completion Increment

The second API increment extends the same typed, same-origin boundary to the remaining workspace resources: Skills, MCP Servers, Model Providers, Artifacts, Usage, and Audit Logs. These resources remain workspace-owned and are queried through TanStack Query; browser pages no longer import mock records at runtime. The local persistence target is SQLite.

Provider and MCP credentials are write-only inputs. API responses expose connection state, masked metadata, provider kind, endpoint metadata, model catalogs, and custom-header names, but never secret values. Provider custom headers must be a JSON object with string keys and values; omitted headers preserve the stored value during an update, while an explicit empty object clears them. Skill and artifact content is treated as untrusted data. The first local implementation stores textual artifact content and skill metadata in SQLite while preserving the object-storage boundary for binary archives and large payloads. Audit events are append-only records written by resource services. Usage is a read model derived from persisted runs for the initial increment.

This increment does not add third-party identity-provider integration, arbitrary MCP `stdio` execution, binary archive processing, or compatibility aliases for mock routes.

## Repository Structure

```text
worklite/
|-- apps/
|   |-- web/                         # React and Vite SPA
|   |   `-- src/
|   |       |-- components/
|   |       |-- features/
|   |       |   |-- agents/
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

- Drag-and-drop workflow canvases.
- Branches, loops, parallel nodes, and arbitrary graph edges.
- Dynamic script-authored workflow orchestration as the primary Workflow model.
- A third-party plugin marketplace or untrusted in-process plugin execution.
- Arbitrary user-supplied MCP `stdio` processes.
- Resume from an arbitrary failed node.
- Temporal or another durable workflow platform.
- Multi-installation tenancy.
- Binary Skill assets, archive upload, package validation, and immutable Skill publication.

Adding a deferred capability requires an approved architecture change.

## Changelog

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

- Added `worklite-platform` as a protected built-in Skill permanently assigned only to System Helper Chat.
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
- Added `docs/internationalization/README.md` as the internationalization source of truth.

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
