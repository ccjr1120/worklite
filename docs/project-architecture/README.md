# Project Architecture

## Status and Governance

This document is the source of truth for the WorkLite architecture. Architecture changes must follow the `Project Architecture Change Workflow` in `AGENTS_WORKFLOW.md`: discuss the change with the user, obtain explicit confirmation, update this document and its changelog, and only then implement the approved design.

This is the approved initial baseline. Target-state components may be introduced incrementally.

## Product Overview

WorkLite is a team-oriented platform for creating and running AI agents and workflows. Teams manage members and team-scoped model providers, agents, skills, MCP servers, workflows, runs, and artifacts.

Agents are configured manually with their own prompts, model settings, skills, and MCP access. Users compose existing agents into workflows. A workflow can be edited with explicit add-node controls or through a natural-language AI assistant. Every AI change is recorded and reversible, similar to an AI-assisted code editor.

A team-scoped workspace assistant can also guide provider setup and propose new Skill, MCP server, and Agent configurations. Assistant proposals remain structured, reviewable, and subject to the same validation, authorization, secret-handling, publication, and audit rules as manual configuration.

## Architectural Principles

1. Use a browser/server architecture with separately deployable web, API, and worker applications.
2. Keep applications and shared packages in a TypeScript monorepo.
3. Use the team as the tenant and resource-isolation boundary.
4. Keep published versions immutable and bind runs to explicit versions.
5. Start with linear workflows instead of a general graph engine.
6. Execute long-running work asynchronously outside the API process.
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
                  |-- PostgreSQL
                  |-- Redis / BullMQ --> Worker
                  |                       |-- Model providers
                  |                       |-- MCP servers
                  |                       `-- Skill sandbox
                  `-- S3-compatible object storage

Browser <---- Server-Sent Events ---- API
```

The web application is delivered as static assets. The API owns authentication, authorization, domain operations, workflow revisions, run creation, and progress delivery. Workers execute agents and workflows. The API must not execute long-running workflows directly.

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

Authenticated workspace routes do not include a locale segment. The web application resolves and persists a personal locale preference, falls back to English, and translates product-owned presentation content at the UI boundary. API contracts, persisted domain values, identifiers, logs, and externally supplied content remain language-neutral. `docs/internationalization/README.md` is the source of truth for internationalization requirements.

### API and Execution

- NestJS for the HTTP API.
- A separately deployed NestJS standalone worker.
- REST for configuration and command APIs.
- Server-Sent Events for one-way progress delivery.
- BullMQ backed by Redis for asynchronous jobs, retries, concurrency control, and worker distribution.

### Persistence

- PostgreSQL as the primary system of record.
- Drizzle ORM for schemas, migrations, and type-safe queries.
- Redis for BullMQ and short-lived coordination data, not as the primary database.
- S3-compatible object storage for skill archives, attachments, large outputs, and artifacts.

Core relationships use relational tables. Versioned workflow definitions and revision operations may use PostgreSQL `jsonb`. Binary files and large payloads belong in object storage; PostgreSQL stores metadata and object keys.

### Operations

- OpenTelemetry for traces and metrics.
- Sentry for error reporting.
- Vitest for unit and integration tests.
- Playwright for browser end-to-end tests.
- Docker Compose for the initial local and self-hosted environment.

## Domain Model and Tenancy

```text
Team
|-- Member
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
        `-- ordered AgentNode references AgentVersion
            `-- WorkflowRun
                `-- NodeRun
```

All team-owned records include `team_id`. Server-side queries and authorization checks must enforce team membership and permissions. Application-level tenant filtering is required initially. PostgreSQL row-level security may later provide additional defense.

## Agent Architecture

An agent is manually configured with a name, description, optional avatar, model selected from the team's configured model providers, system prompt, skills, MCP access, and supported runtime settings. Agent versions are immutable.

Workflow nodes reference an existing agent version from the same team. A node may override only an approved subset of settings: a compatible model identifier, temperature, maximum output tokens, and output format. Nodes cannot override the system prompt, skills, MCP servers, or tool allowlist.

A published workflow locks every referenced `AgentVersion`; later agent edits cannot alter published workflows or historical runs. Deleted referenced agents use soft deletion so historical versions remain executable and auditable.

Model providers are team-scoped resources and are presented in the Agent resource surface for workspace navigation. Agents may reference models exposed by a provider belonging to the same team. Provider credentials remain write-only and provider changes do not mutate immutable published workflow versions.

## Workspace Assistant Architecture

The workspace assistant is a team-scoped, task-oriented interface for configuring model providers and creating Skills, MCP servers, and Agents. It supplements the existing resource editors rather than replacing them.

The assistant follows a propose-review-apply model:

1. Collect the user's goal and the minimum non-secret configuration needed to understand it.
2. Produce a resource-specific structured proposal with explicit dependencies, missing fields, validation state, and intended operations.
3. Require user confirmation before applying any operation.
4. Apply confirmed operations through the same domain services used by manual resource forms.
5. Return durable per-operation results and direct links to the affected resources.

The assistant cannot write arbitrary resource state, bypass authorization, publish immutable versions without confirmation, or silently expand MCP tool access. Provider credentials and other secrets are entered through dedicated secure fields and are excluded from assistant turns, model context, proposal payloads, ordinary logs, and error details.

Assistant operations use stable resource-specific contracts. Initial operation families cover provider configuration, Skill draft creation, remote Streamable HTTP MCP connection and discovery, and Agent draft creation. Every operation is validated server-side and audited under the initiating user. Partial failure must preserve completed resources, identify the failed operation, and offer a safe retry or manual-edit route.

The initial web increment may use local mock conversations and proposal execution to validate the interaction model. Persistent assistant sessions, model-backed proposal generation, and server-side application are later increments of this approved architecture; the UI must clearly avoid implying that mock results are durable.

## Skill Architecture

A skill is a team-scoped, versioned package that may contain:

```text
SKILL.md
scripts/
references/
assets/
```

The product supports creating a skill online, uploading an archive, editing instructions, validating the package, and publishing an immutable version.

User-supplied executable content must not run inside the API or worker main process. It must use a sandbox abstraction with explicit filesystem, network, time, memory, and CPU limits. The first release may restrict executable capabilities until an adequate sandbox is available.

## MCP Architecture

MCP servers are team-scoped and versioned. The initial implementation prioritizes remote Streamable HTTP connections. Arbitrary user-supplied `stdio` processes are deferred because they require stronger isolation and operational controls.

The configuration flow is:

1. Enter endpoint and authentication configuration.
2. Test the connection on the server.
3. Discover available tools.
4. Select the tools agents may use.
5. Publish an immutable MCP version.

Secrets use a secret-storage abstraction and must never be returned in full or written to ordinary logs. MCP output is untrusted input. Tool calls must be authorized and auditable.

## Workflow Architecture

### Initial Workflow Model

The initial workflow is a fixed, ordered list of agent nodes. It does not support arbitrary edges, branching, loops, parallel execution, or backward jumps.

Each node has a stable identifier, integer position, agent-version reference, optional input template, restricted runtime overrides, and an error policy initially limited to `stop` or `retry`. A node receives the original workflow input, previous-node output, and workflow variables. Its successful output becomes the next node's input.

Every workflow definition includes a `schemaVersion` for future migrations.

### Editing and AI Assistance

The editor is structured and does not use drag-and-drop. Users add nodes with explicit controls. A side-panel AI assistant can modify the workflow from natural-language instructions.

AI edits are validated structured operations: add, delete, update, or reorder a node. The AI cannot write arbitrary workflow state directly. The server validates and atomically applies operations.

Every manual or AI edit creates an `EditRevision` with its actor, optional source instruction, operations, resulting snapshot or snapshot reference, and timestamp. The initial strategy uses immutable snapshots and a current-revision pointer. This favors reliable undo, redo, refresh recovery, and cross-device recovery. Zustand may provide immediate local history, but server revisions are authoritative.

### Drafts and Published Versions

```text
WorkflowDraft --publish--> immutable WorkflowVersion --run--> WorkflowRun
```

Drafts can change. Published versions cannot. Publication resolves and locks agent-version references. Every execution is tied to one immutable workflow version.

## Runtime Architecture

Runs are asynchronous because they may take minutes or longer:

```text
Create run
  -> persist WorkflowRun
  -> enqueue job
  -> execute nodes in order
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

A `WorkflowRun` stores its team, workflow version, input, current node, timestamps, final result, and status. A `NodeRun` stores its agent version, input, output, status, duration, retry count, and relevant model, skill, MCP, and tool-call activity.

Runtime requirements include node and workflow timeouts, cooperative cancellation, worker heartbeats or leases, persisted intermediate results, classified transient retries, idempotency for retryable external side effects, and per-team concurrency, duration, and model-usage quotas.

Resume from a failed node is deferred, but completed node runs must be retained. BullMQ is the initial execution engine. Temporal should only be evaluated after requirements include long waits, human approval, complex branching, or stronger durable-execution semantics.

Initial run endpoints are:

```text
POST /workflow-versions/:workflowVersionId/runs
GET  /runs/:runId
GET  /runs/:runId/events
POST /runs/:runId/cancel
```

Production uses a same-origin `/api` route through the reverse proxy to simplify cookies, CORS, and Server-Sent Events authentication.

## Repository Structure

```text
worklite/
|-- apps/
|   |-- web/                         # React and Vite SPA
|   |   `-- src/
|   |       |-- components/
|   |       |-- features/
|   |       |   |-- auth/
|   |       |   |-- teams/
|   |       |   |-- members/
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
|   |           |-- auth/
|   |           |-- users/
|   |           |-- teams/
|   |           |-- members/
|   |           |-- agents/
|   |           |-- skills/
|   |           |-- mcp-servers/
|   |           |-- workflows/
|   |           |-- workflow-revisions/
|   |           |-- runs/
|   |           |-- artifacts/
|   |           |-- model-providers/
|   |           |-- usage/
|   |           `-- audit-logs/
|   `-- worker/                       # BullMQ worker
|       `-- src/
|           |-- processors/
|           |-- consumers/
|           |-- services/
|           `-- infrastructure/
|-- packages/
|   |-- contracts/                    # Shared API and event contracts
|   |-- db/                           # Drizzle schemas and migrations
|   |-- workflow-engine/              # Framework-independent workflow logic
|   |-- agent-runtime/                # Agent execution and tool orchestration
|   |-- model-gateway/                # Model-provider abstraction
|   |-- mcp-client/                   # MCP discovery and execution
|   |-- skill-sdk/                    # Skill parsing and validation
|   |-- sandbox/                      # Skill isolation abstraction
|   |-- queue/                        # Shared BullMQ contracts and policies
|   |-- auth/                         # Shared roles and permissions
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
apps/worker
packages/contracts
packages/db
packages/workflow-engine
packages/agent-runtime
packages/queue
packages/ui
packages/config
```

The model gateway, MCP client, skill SDK, sandbox, and observability code may begin inside applications or the runtime and move to dedicated packages when their boundaries stabilize.

## Deferred Capabilities

- Drag-and-drop workflow canvases.
- Branches, loops, parallel nodes, and arbitrary graph edges.
- Arbitrary user-supplied MCP `stdio` processes.
- Resume from an arbitrary failed node.
- Temporal or another durable workflow platform.
- Database-per-team tenancy.

Adding a deferred capability requires an approved architecture change.

## Changelog

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
