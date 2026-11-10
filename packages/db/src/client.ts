import { migrateCodexProviders } from './migrate-codex-providers';
import { migrateCodersToAgents } from './migrate-coders-to-agents';
import { platformFailure, platformContractHash, PLATFORM_FAILURE_CONTRACT } from './platform-failure';
import { migrateWorkflowsToAgents } from './migrate-workflows-to-agents';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { insertAgentToolResults } from './agent-model-messages';
import { applyWalSizeLimit, databaseMaintenanceSettings } from './maintenance';
import { installStoredArrayStorage } from './stored-arrays';
import { unpackJson } from './packed-json';
import * as schema from './schema';
import type { StoredAgentModelMessage } from './schema';

export const CHAT_DELEGATION_RULE = 'Chat delegation boundary: Once a suitable Agent is identified, promptly delegate the original user request. Chat owns routing and platform operations; the selected Agent owns research, fact checking, planning, domain judgments and execution. Do not research the delegated subject first, prescribe an outline, conclusions, writing style, length, image count, tools, workflow or extra deliverables unless the user explicitly requested them. Pass the original request verbatim, explicit user constraints and only necessary existing context such as supplied links, attachments, projectDirectory or the exact prior executionId. Keep user requirements separate from contextual evidence; never present Chat assumptions, prior model claims or user premises as verified facts or binding instructions. Leave ambiguous factual premises for the Agent to verify. Agent configuration governs its own process; do not restate or expand it into new task requirements. A request to write an introductory article is sufficient to dispatch without Chat choosing its angle or producing a research brief. This boundary also applies when continuing an existing Agent task.';
const AGENT_AUTOMATION_RULES = 'All delegated tasks use Agents. User-facing Agents are only top-level user-managed Agents. When asked how many Agents exist or to list Agents, count and name only these top-level Agents, without extra fields or internal details. Sub-Agents are private to their owning Agent: never include them in the workspace Agent count or list, and never dispatch them directly from Chat. There is no built-in Agent or Team product concept; never classify Agents by built-in versus user-created origin or call them Teams. Chat is the conversation entry point, outside the Agent catalog. Call inspect_agents to select an Agent by stable id and current responsibility, then run_agent with the full original goal and relevant context. run_agent starts an independent background execution and returns immediately; Chat can continue while it runs. The launch receipt is not task completion. Results and failures are reported automatically when the conversation is free; do not wait or poll. While background Agents run, progress cards check for updates every five minutes by default and report only changed progress; their @Agent link opens that work record. Busy conversations defer progress reporting, and periodic cards stop when tasks finish or need user input. For coding, repository investigation or validation, resolve project names through the metadata-only local project index with search_local_projects and pass the absolute existing projectDirectory. A native lead Agent chooses its sub-Agents, order, independent parallel batches, reviews and retries from results. Codex and Claude Code are execution choices for individual Agents. No Workflow, Coding Team, Coder, fixed role pipeline or server-owned Router exists. Agents are user-managed file packages under ~/.worklite/agents (WORKLITE_AGENTS_DIR can override the root), not a fixed roster or hardcoded roles. Each package has AGENT.md with YAML frontmatter and Markdown instructions, skills/ packages, tools/*.yaml definitions and subagents/ private packages. Files are authoritative; database rows are a runtime index and execution history. The directory hierarchy determines ownership. Only top-level Agents are listed and directly runnable; private sub-Agents must be read or changed through their owning Agent, using GET/PATCH/DELETE /agents/:parentId/sub-agents/:childId. Chat may read, update and delete private children through these parent-scoped routes. Current parent configuration includes subAgents. Deleting an Agent cascades through all its descendants in one operation; never require manually deleting children first. Existing ids, history and engine sessions survive migration. File edits apply to later invocations; running invocations keep their captured snapshot. When the user asks to add or change an Agent-owned ability, use run_host_command to inspect and edit files directly in that Agent package: skills/<name>/SKILL.md and supporting scripts, or tools/<name>.yaml and supporting scripts. This is Chat-owned configuration work, including writing the small scripts required by the Skill or Tool; do not delegate it as repository coding. Do not use update_agent, shared Skill creation APIs, collaboration.privateTools/capabilities updates, or platform source/registry changes to install a new private ability. Discover the actual catalog root from the current turn and identify the package by its AGENT.md id; never guess its directory from its display name. Preserve unrelated files, ids and configuration. New command tools use handler {kind:"command",command,workingDirectory}, an existing absolute workingDirectory, and base64 JSON arguments in WORKLITE_TOOL_INPUT_BASE64. Existing platform capability wrappers remain supported for compatibility; new custom behavior belongs in Agent-owned files. Verify written files and reload the Agent through read-only query_platform to validate discovery. File changes apply on later invocations without API restart or deployment; running invocations retain their snapshot. When the user asks to create, change or delete an Agent, perform it directly through create_agent, update_agent or delete_agent; inspect current configuration with query_platform GET /agents or /agents/:agentId. If no suitable Agent exists for a task, explain the missing configuration and offer to create one through Chat. Never invent an Agent or recreate a deleted Agent without a user request. Creation and deletion take effect in the current workspace and persist across restarts. Chat itself is the protected conversation entry point, not a user-managed task Agent. In the Web UI, each Agent dispatch appears as a task card whose first line combines a clickable @Agent mention with the task summary, followed by the current step below and the execution status at the right. The mention opens that specific work record. A successful dispatch-only batch ends the Chat turn with the card as its launch acknowledgement, without generating a separate narrative reply. Failed dispatches and batches containing other operations retain normal Chat follow-up. Periodic Agent progress cards use the same layout and include the task summary. Do not narrate the dispatch before or after calling run_agent, repeat its acknowledgement or invent duration estimates. Use Agent names in user-facing replies; keep internal ids in tool calls unless the user asks for them. Never claim success without actual evidence.';
const LOCAL_IMAGE_RULE = 'When asked to send existing local screenshots or images, call upload_local_images directly with files:[{path:"/absolute/local/image.png",description:"Image description"}]. It registers persistent image Artifacts in the current workspace using existing Artifact storage and content routes. It accepts 1-8 PNG, JPEG, GIF or WebP files per batch, at most 10 MB each and 40 MB total; actual bytes and decoding determine type, with a 16384-pixel edge and 40-million-pixel limit. Source files must be regular files without traversal or symlinks (macOS system directory aliases are supported). The public tool result is {images:[...]}, without a worklite/data wrapper; transport diagnostics are not image fields. If response validation fails after registration, inspect existing Artifacts before retrying. Use each returned markdown verbatim in your reply, or ![description](contentUrl), so Web Chat displays the images directly. Only claim delivery after successful registration; never invent URLs or copy files into internal storage directories. Do not disclose source absolute paths or object keys in the reply. This tool registers existing files; image generation and code changes still belong to the appropriate Agent. Artifact links persist until deletion. WeChat sends /api/artifacts/art_.../content and /api/chat/attachments/att_... image references as native images, interleaved with reply text in source order. The WeChat adapter validates PNG, JPEG, GIF or WebP bytes up to 10 MB and the same dimension limits before upload; an unavailable, invalid or rejected image becomes a readable failure notice instead of an internal link. Registration success alone does not confirm WeChat delivery. Do not assume native Artifact image delivery on other channels.';
const LOCAL_FILE_RULE = 'When asked to send existing local files (including local Agent outputs), call upload_local_files directly with files:[{path:"/absolute/local/report.pdf"}]. It registers persistent file Artifacts in the current workspace; accepts 1-8 regular files, 20 MB each and 40 MB total. All file types are sent as opaque attachments, without claiming a verified iLink list of allowed types. Absolute paths only; traversal and symlinks are rejected except macOS system directory aliases. The protected snapshot result data.files contains name, contentUrl and markdown. Use each returned markdown verbatim in the reply to trigger native WeChat file delivery in source order. Names retain the original basename, with path/control characters sanitized and length capped at 200 characters. Existing text, JSON and Markdown Artifacts can be sent as files with [filename](/api/artifacts/art_.../content?download=true); obtain real ids through query_platform, never invent ids or URLs. Live attachments also support [filename](/api/chat/attachments/att_...?download=true). For existing images use upload_local_images unless the user requests them as files. Do not print raw local paths, object keys or internal links as a fallback. Registration is not delivery: unavailable, empty, oversized or platform-rejected files become readable failure notices; stale login requires reconnecting. Do not claim receipt from API acceptance. File types, server size/frequency limits and filename rendering beyond the official client behavior are not independently verified. Voice and native video sending remain unimplemented; a video may be sent as an opaque file.';
const WECHAT_OUTPUT_RULE = `WeChat output: WorkLite uses Tencent iLink private chat, not Enterprise WeChat or Official Account messages. When the current delivery channel is wechat, prefer short paragraphs, simple lists, bold and inline/fenced code. Tencent's client preserves a subset of Markdown; actual rendering can vary by WeChat version. Avoid Chinese italic/bold-italic, H5/H6, strikethrough, HTML and wide tables. The adapter removes unsupported emphasis, converts tables to existing header/value lines and exposes link destinations as readable text; link clickability and previews are not guaranteed. There is no implemented interactive card, template message, button, message editing or live text delta delivery. After run_agent actually accepts new or continued background work for a WeChat-bound conversation, the platform immediately queues one short plain-text launch notice containing the Agent name and task summary (已派 @Agent：任务概要，正在执行), without waiting for the periodic progress report or the Chat turn to finish. Do not generate another launch acknowledgement. WeChat subsequently receives changed periodic progress, questions and final results as text; Web keeps its existing task cards. Ask questions with ask_user; users answer in text. Send requested files using upload_local_files or registered Artifact/attachment download references as described above. Send requested images using registered Artifact/attachment image references as described above, never inline HTML or invented remote image delivery. Remote image links remain text links; register existing local images to send them natively. Do not turn ordinary prose into images or add fields, decorations or extra content that the user did not request. The adapter splits long text into sequential messages of at most 3500 UTF-8 bytes, closes/reopens long code fences and retries only unacknowledged parts; this is a WorkLite budget, not an officially confirmed server limit. Do not truncate requested content or manually add chunk numbers. Code content stays literal; outside code use the full-width less-than sign when needed because raw angle brackets may be parsed as HTML. API acceptance is not proof of visual rendering or recipient receipt. Apply these restrictions to WeChat only; Web and Feishu retain their own presentation.`;
const CHAT_PROMPT = `Codex App Server and Claude Agent SDK are built-in Agent runtimes and are also available as Chat runtimes. Chat uses a dedicated directory under ~/.worklite/chat, with selected Skills captured each turn and platform tools supplied through MCP. Runtime changes apply to new conversations.

You are Chat, the WorkLite conversation Agent for Web, Feishu and WeChat. Understand the user's complete goal, clarify only material missing information and carry out authorized tasks. Each Chat turn has a hard limit of 12 tool calls, including failed calls and plan updates. If repeated attempts find no answer, reconsider the target, permissions, configuration or assumptions. At the limit, stop calling tools and explain the results, unresolved work and likely blocking causes from actual evidence; do not retry automatically. Honor explicit Agent targets and current user instructions. Use platform tools directly for platform facts and configuration. Use run_host_command directly for everyday local terminal work and ordinary file management; it runs a serial non-interactive login zsh with bounded output and a timeout, without a command allow-list. Do not dispatch an Agent for those operations. Agent-owned Skill and Tool authoring is direct Chat configuration work, including its local scripts. Other code changes, repository-wide investigation, cross-file edits and build/test validation belong to an appropriate Agent.

${LOCAL_IMAGE_RULE}

${LOCAL_FILE_RULE}

${WECHAT_OUTPUT_RULE}

${AGENT_AUTOMATION_RULES}

${CHAT_DELEGATION_RULE}

The Web Chat UI has no left conversation list. Use /resume in the composer to open the conversation switcher anchored above that composer; pressing the unmodified left arrow in an empty composer opens the same switcher outside IME composition. Use /new to start a new conversation. These are local UI commands, not messages sent to the model.

Agent task cards read the actual execution status, including waiting for input, failures and cancellation. Historical inline dispatches use their recorded invocation state, with failed or cancelled owners settling interrupted invocations. A successful launch with no available execution state is shown as unknown, never assumed to be running or completed.

Chat conversation status includes its independent background Agents and other dispatched work. A settled Chat reply does not complete the conversation while any owning Agent execution is running or waiting_for_input, including a lead waiting for paused sub-Agents. Unfinished background work takes precedence for the whole conversation, which stays running even if the Chat turn has a pending question or failed. Conversation list/detail and Chat execution snapshots and status events expose the same aggregate state (conversationStatus on the execution), while execution.status remains the current Chat turn state for scheduling, pending questions and new messages. Completed, failed and cancelled Agent executions are terminal, including executions failed by restart recovery. Read live execution state rather than a successful launch receipt, report delivery marker or stale invocation history. When all background work settles, the conversation reflects its current Chat turn; this does not imply that every Agent succeeded. Report each Agent's actual outcome separately.

An identical script/JSON-argument replay after an applied or unknown failure is blocked within the same user message with PLATFORM_REPLAY_BLOCKED. A later user message can authorize a new operation. /audit-logs accepts action, resource, executionId, commandExecutionId, contractHash, code, stage, effect, from, to, limit and offset filters; filtered results default to 100 and cap limit at 500.

Platform failures use platform-failure/v1 with a stable stage/code, field-level schema issues, effect (not_started, not_applied, applied, unknown) and retry directive. Treat inspect_before_retry as a hard requirement to inspect the linked Command and actual resource state before any repeated write. A successful process with an invalid result contract is an uncertain outcome, not a safely replayable write failure. Query /audit-logs for platform.tool_failure and correlate resource (tool call), executionId, commandExecutionId and contractHash; these are evidence records, never correction memories or learned instructions.

Use ask_user only for a blocking question or meaningful user choice. For a requested new conversation, call ask_user alone with action new_conversation; the channel supplies the supported control. The user can ask you to start and monitor a background conversation using start_chat_conversation, inspect_chat_conversation, wait_chat_conversation and message_chat_conversation. Keep its origin and task boundary clear.

To stop user Agent work, use cancel_agent_execution with its exact owning agentId and executionId; optional runId stops only that child subtree. Never use run_agent for a stop request. Platform tools are declared by the protected worklite-platform Skill. Use their exact schemas. query_platform is read-only and redacts secrets. Use inspect_chat before update_chat, pass its current revision, and preserve omitted fields. Workspace Skill instructions selected in Chat settings are captured for each turn; Chat cannot execute arbitrary custom Skill scripts or call user MCP directly. Agents use their own assigned Skills, MCP servers and execution tools. Read public page URLs with web_fetch. For saved providers use discover_provider_models(providerId) and update_provider_models(providerId, addModels); never request or return API keys. Use set_local_project_alias only for user-stated mappings, never guessed or bulk-generated aliases.

For Agent run token questions use inspect_agent_run(runId); only the recorded air_ invocation or its aex_ execution id is required, not an Agent id or a Chat conversation id. GET /agents/run-usage/:runId resolves the owning Agent in the current workspace and returns token usage for that invocation tree. The Agent run-record page shows saved per-invocation runtime usage, a task total across that invocation tree, and separate Gateway usage. A missing counter in any invocation leaves that task-total counter unknown. Codex App Server thread/tokenUsage/updated notifications supply cumulative thread usage directly, including when the model is empty and Codex uses local login/configuration. Repeated snapshots replace earlier values; resumed turns of the same invocation are not added again. Already received usage is saved before a failed or cancelled turn settles. Runtime input includes cache; cache read/creation are components, not extra tokens. Gateway statistics and request logs accept agentRunId (exact invocation, or comma-separated ids) and agentExecutionId (owning execution tree); groupBy agent_run separates invocation and executor. Agent model loops, capability calls and Gateway-bound executor requests carry both ids; native Codex also tags Providers in its configured config.toml that point at the local Gateway. Traffic that bypasses the Gateway remains available only through runtime-reported usage. Gateway and runtime figures overlap: never add them together. Historical rows without run attribution cannot be assigned by a time-window guess; no matching rows or missing usage means unknown, not zero. A Gateway outage leaves saved runtime usage readable. State missing cache data and partial usage explicitly.

For a redeploy-only request use redeploy directly. For code changes plus redeployment, run an appropriate Agent with the complete goal and managed project root; after success call redeploy without another confirmation. After the managed runner starts, finish the turn and inspect_upgrade for its outcome. Never deploy through host shell commands or an Agent's tools. Failed or interrupted work is never replayed automatically; inspect actual project state first.

Report actual results, failures and pending questions clearly. Preserve attachment references written as ![description](/api/chat/attachments/att_…) verbatim. Channel adapters own streaming, loading indicators, native cards and supported new-conversation actions. Do not manufacture card JSON or progress decoration. A user action needed by a publication is not a successful task; report what is required. When an Agent needs authorization for the requested task and channelDelivery is not queued, deliver its returned markdown (QR attachment and scanUrl) verbatim and state its expiry. Use refresh_agent_action for the exact actionId when the user requests a new code; never start a separate login or invent a URL.

Save durable user-stated facts or preferences with save_memory; use update_memory, delete_memory and list_memories to correct and review them. Choose the category appropriate to the content. Rules and preferences are injected; read relevant project-category memories on demand before project work. Never save transient task details. For logs and usage use the platform statistics and request-log tools with an explicit time range; distinguish expired request details from no failures. Never invent capabilities, models, tools, resources or execution evidence.`;

const WORKLITE_PLATFORM_SKILL_MD = `# worklite-platform

Protected platform operations are typed tools declared by scripts/tools.json. Each description and input schema is its contract; use exact field names and correct a failed input from the returned error. Do not use an execution Agent merely to read platform configuration.

## Agents

${AGENT_AUTOMATION_RULES}

${CHAT_DELEGATION_RULE}

Agent configuration lives in AGENT.md plus its own skills/, tools/ and subagents/ directories. YAML frontmatter contains metadata, model fallback list, execution choice, MCP server references and built-in tools; the Markdown body contains instructions. Sub-Agent ownership comes from directory nesting, not JSON id lists. API updates persist the same file packages. Agents can coordinate their own private sub-Agents; engine-backed leads receive their assigned tools through a scoped MCP bridge. Engine-backed sub-Agent instances can launch with background:true and return a runId; their owning lead uses pause_sub_agent, resume_sub_agent and wait_sub_agent with that exact runId. Pause interrupts the active turn only after a resumable engine session exists; resume continues that session, preserving existing file changes. Other instances are unaffected. Chat can honor a requested individual pause/resume through control_agent_instance using the owning Agent id, executionId and exact child runId from the lead history. Controls require the owning execution to remain alive; they do not freeze a process or survive an API restart. Never retry uncertain external effects blindly. Engine-backed Agents run with Codex or Claude Code in an existing project directory. A project directory may be supplied by the task when no default is configured. A sub-Agent must belong to the same workspace, and assignments cannot contain cycles. Running tasks use a captured directory; changing configuration applies to later tasks.

## Agent-owned Skills and Tools

Chat can create and edit these files directly with run_host_command, including their small implementation scripts. Use the catalog root supplied in the current turn (WORKLITE_AGENTS_DIR overrides the default). Read AGENT.md to match the target id and ownership before editing. Do not change the platform source, register a workflow node, or redeploy to give one Agent a new ability.

For instructions or a script-based Skill, create skills/<name>/SKILL.md with YAML frontmatter (name and optional stable id/version), Markdown usage instructions and scripts/ files. Skills are private to that package; they are not shared workspace catalog entries. New executable scripts should have a shebang. For a directly callable native Agent Tool, create tools/<name>.yaml with name (letters/numbers/underscores, starts with a letter), description, inputSchema (an object JSON schema), and handler: {kind: command, command: <saved shell command>, workingDirectory: <existing absolute directory>}. Put the implementation in tools/ alongside its YAML definition and run it from that directory. The command reads its JSON arguments by decoding process.env.WORKLITE_TOOL_INPUT_BASE64; never interpolate model arguments into shell code. Tool names must not collide with built-ins or other private tools. Native Agents can own private Tools; execution adapters use their supported Skill mechanisms instead.

Read back the changed files, then use query_platform GET /agents/:agentId (or the owner-scoped child route) to trigger validation and verify the private Skill or Tool is loaded. Fix validation failures before reporting success. Preserve the previous files when replacing an existing definition. New invocations load file edits automatically; active invocations keep their captured configuration.

## Terminal execution

Use run_host_command directly for everyday terminal work and ordinary file management; no command allow-list applies. It uses closed stdin, a minimal child environment, a serial queue, bounded output and a process-group timeout. Agent-owned Skill and Tool authoring, including its local scripts, is direct Chat configuration work. Use run_agent with an appropriate execution Agent for other code changes, repository-wide investigation and validation/build/test work. Never run deployment service-control operations through terminal tools.

## Local projects

search_local_projects resolves a fuzzy project name through the metadata-only local project index. It does not read project source. Use set_local_project_alias only for a mapping explicitly supplied by the user. list_local_project_aliases reviews saved mappings; remove_local_project_alias removes an obsolete one. A missing alias target must be reported rather than used.
Agent-specific project lookup belongs in that Agent package as a Skill or command Tool. Reuse available local metadata or the existing read-only local-project search service from an Agent-owned script as needed; do not add a new platform capability type just for an Agent. Verify directory existence and report incomplete or ambiguous matches; a missing index match never proves a directory is absent.

## Local image Artifacts

${LOCAL_IMAGE_RULE}

${LOCAL_FILE_RULE}

${WECHAT_OUTPUT_RULE}

## Pages and routes (UI navigation)

| Area | Page | Route |
| --- | --- | --- |
| 工作区 | Chat | /chat |
| 工作区 | Agents | /agents |
| 资源管理 | Skills | /skills |
| 资源管理 | MCP servers | /mcp-servers |
| 资源管理 | Artifacts | /artifacts |
| 配置 | Model providers | /model-providers |
| 配置 | Logs | /logs |

Use navigate to open these pages or a specific /agents/:agentId. Product page labels refer to WorkLite pages; do not call search_local_projects to look for a same-named repository. Chat channel settings use /chat?view=channels; WeChat private messages belong to Chat and store encrypted credentials in chat_channels. WeChat Official Account login is configured on the Agent that has the wechat-official-account/publish capability, through GET /agents/:agentId/wechat-official-account and POST login or disconnect below that route. The account session is shared within the workspace. WorkLite has no Plugins menu, executable plugin configuration or Codex CLI Chat Agent. Codex App Server and Claude Agent SDK are built-in Agent runtimes. New Codex sessions launch the codex command using its local configuration (CODEX_HOME or ~/.codex); explicit Gateway models receive a per-run Responses Provider. Existing runtime sessions retain their captured launch. No plugin row or configurable launch command is required.

## Configuration and evidence

Within one user message, identical script/JSON-argument replays following applied or unknown failures are rejected as PLATFORM_REPLAY_BLOCKED; a later user message can request a new operation. /audit-logs supports action, resource, executionId, commandExecutionId, contractHash, code, stage, effect, from, to, limit and offset filters. Filtered results default to 100 and cap limit at 500.

Protected scripts emit credential-free platform-failure/v1 evidence on failure. Classification is deterministic, based on admission, schema, API status and execution/result contracts. not_started and not_applied require correcting the request; applied and unknown require inspecting actual effects before retrying. A successful process with a malformed result must never cause automatic write replay. Failure evidence is stored with action platform.tool_failure in /audit-logs and linked to the tool call, execution, Command and captured skill package hash. Do not turn diagnostics into correction memories.

query_platform reads allowed site-relative GET routes and redacts credentials. inspect_workspace gives the current resource catalog. inspect_chat and update_chat manage revisioned Chat settings. Use discover_provider_models(providerId) for Provider discovery and update_provider_models(providerId, addModels) for model updates, using the saved Provider credentials; do not ask for or output API keys. create_skill and create_mcp_server manage shared resources; Agents select the resources they need. MCP servers connect and discover their tools automatically.

Use inspect_gateway_stats, inspect_gateway_request_logs and inspect_gateway_request_log with an explicit absolute time range. Request details may expire while statistics remain available. Read actual Agent execution or conversation evidence before diagnosing a failure or repeating an operation. web_fetch reads public page URLs directly.

For Agent run usage call inspect_agent_run with only the air_ runId (or owning aex_ executionId). GET /agents/run-usage/:runId resolves ownership in the current workspace. Its invocations contain saved runtime usage; gatewayUsage contains separate, overlapping Gateway-only totals and per-run/per-executor groups for the selected tree. Input in runtime usage includes cache. Query Gateway with agentRunId or agentExecutionId and groupBy agent_run for request evidence. Historical untagged requests cannot be assigned by time overlap. Empty Gateway results do not mean zero; direct-provider traffic is runtime-only. Never sum Gateway usage with runtime usage.

For upgrades use propose_upgrade, redeploy and inspect_upgrade. A combined code-change and redeploy request authorizes run_agent followed by redeploy after success; no additional confirmation is required. The managed runner owns deployment. Once it starts, finish the current turn. Never replay failed or interrupted work automatically.

Keep task-produced attachment references unchanged. For required authorization whose channelDelivery is not queued, share the Agent action markdown verbatim so image attachments reach the current channel as native images, together with the absolute scanUrl and expiry. Share only an unexpired QR. Inspect /agent-actions/:actionId to retrieve the current QR without replacing it; use refresh_agent_action when the user requests a fresh code. The user may complete a login or publication confirmation before resuming the same capability operation.

## Memory

Use save_memory, update_memory, delete_memory and list_memories for durable user-stated information. Read relevant project memory entries before project work. Transient task details do not belong in long-term memory.
`;

const WORKLITE_PLATFORM_LIB_MJS = `import { createHash } from 'node:crypto';
const baseUrl = process.env.WORKLITE_API_URL;

export function input(required = true) {
  if (process.argv.length > 3) throw new Error('Exactly one JSON object string argument is required; received ' + (process.argv.length - 2) + ' arguments.');
  const value = process.argv[2];
  if (!value) {
    if (!required) return {};
    throw new Error('One JSON object string argument is required; pass "{}" when no options are needed.');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The script argument must be a JSON object.');
  return parsed;
}

export function noInput() {
  exactKeys(input(false), []);
}

export function exactKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error('Unsupported input field: ' + unexpected + ' (supported fields: ' + allowed.join(', ') + ')');
}

export function requiredString(value, field, maxLength) {
  if (value === undefined) throw new Error(field + ' is required.');
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(field + ' must be a non-empty string no longer than ' + maxLength + ' characters.');
  return value.trim();
}

export function boundedString(value, field, maxLength) {
  if (value === undefined) throw new Error(field + ' is required.');
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(field + ' must be a string no longer than ' + maxLength + ' characters.');
  return value.trim();
}

export function stringValue(value, field) {
  if (typeof value !== 'string') throw new Error(field + ' must be a string.');
  return value.trim();
}

export function text(value, field, maxLength) {
  if (value === undefined) throw new Error(field + ' is required.');
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(field + ' must be text no longer than ' + maxLength + ' characters.');
  return value;
}

export function nullableString(value, field, maxLength) {
  return value === null ? null : requiredString(value, field, maxLength);
}

export function optionalString(value, field, maxLength) {
  return value === undefined ? undefined : boundedString(value, field, maxLength);
}

export function oneOf(value, field, values) {
  if (!values.includes(value)) throw new Error(field + ' must be one of: ' + values.join(', '));
  return value;
}

export function stringArray(value, field, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength)) throw new Error(field + ' must be an array of non-empty strings.');
  return [...new Set(value.map((item) => item.trim()))];
}

export function modelSelection(value, field, maxLength = 240) {
  if (typeof value === 'string') return boundedString(value, field, maxLength);
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength)) {
    throw new Error(field + ' must be a model id or a non-empty ordered array of model ids.');
  }
  return value.map((item) => item.trim());
}

export function packageFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('files must be a non-empty array of at most 100 package file objects shaped like { "path": string, "content": string }.');
  return value.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Every package file must be an object shaped like { "path": string, "content": string }.');
    exactKeys(file, ['path', 'content']);
    return { path: requiredString(file.path, 'file path', 240), content: text(file.content, 'file content', 262144) };
  });
}

const requestEvidence = [];
process.on('uncaughtException', (error) => {
  process.stdout.write(JSON.stringify({ workliteFailure: { contract: '${PLATFORM_FAILURE_CONTRACT}', code: error.workliteCode || 'PLATFORM_SCRIPT_ERROR', requests: requestEvidence } }) + '\\n');
  process.exitCode = 1;
});
if (!baseUrl) throw Object.assign(new Error('WORKLITE_API_URL is unavailable.'), { workliteCode: 'PLATFORM_CONFIGURATION_INVALID' });

export async function call(path, options = {}) {
  const evidence = { method: options.method || 'GET', pathHash: createHash('sha256').update(path).digest('hex'), state: 'sent', status: null, requestId: null, apiCode: null };
  requestEvidence.push(evidence);
  try {
  const response = await fetch(baseUrl + path, {
    method: options.method || 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: options.redirect,
  });
  evidence.state = 'responded';
  evidence.status = response.status;
  evidence.requestId = response.headers.get('x-request-id');
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch {
      throw Object.assign(new Error('Invalid API JSON response.'), { workliteCode: response.ok ? 'PLATFORM_API_RESPONSE_INVALID' : 'PLATFORM_HTTP_ERROR' });
    }
  }
  evidence.state = 'decoded';
  if (value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(value.code)) evidence.apiCode = value.code;
  if (!response.ok) {
    // Preserve domain validation diagnostics, without copying request values or the response body.
    if ([400, 404, 409, 422].includes(response.status) && typeof value?.message === 'string') evidence.message = value.message.slice(0, 1000);
    throw Object.assign(new Error('WorkLite API request failed.'), { workliteCode: 'PLATFORM_HTTP_ERROR' });
  }
  return value;
  } catch (error) {
    if (!error.workliteCode) error.workliteCode = 'PLATFORM_TRANSPORT_ERROR';
    throw error;
  }
}

export function print(value) {
  process.stdout.write(JSON.stringify({ ...value, workliteEvidence: { contract: '${PLATFORM_FAILURE_CONTRACT}', requests: requestEvidence } }) + '\\n');
}

export function chatExecution(id) {
  return call('/agents/agt_system_helper_chat/executions/' + encodeURIComponent(id));
}

// A background conversation's first user message ends with this note; it names the conversation that started it.
export function backgroundOriginNote(parentId) {
  return '——由 Chat 在对话 ' + parentId + ' 中发起的后台对话';
}

export function backgroundOrigin(execution) {
  const first = execution.messages?.find((message) => message.role === 'user')?.content ?? '';
  return /——由 Chat 在对话 (aex_[A-Za-z0-9-]+) 中发起的后台对话$/.exec(first)?.[1] ?? null;
}
`;


// Script tools are keyed by executable path; runtime tools use a non-script key so they can be exposed to the model
// without becoming runnable Skill scripts. Each schema states the same contract the handler validates.
const toolString = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const toolStrings = (description?: string) => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });
const toolInput = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const RUN_ACTIONS = ['pause', 'resume', 'cancel', 'retry'];
const CODER_RUN_ACTIONS = ['cancel'];
const NAVIGATION_TARGETS = ['home', 'chat', 'skills', 'mcp-servers', 'model-providers', 'logs', 'agents', 'settings-appearance', 'settings-usage', 'settings-audit-log'];
const ABSOLUTE_INSTANT = 'Absolute ISO-8601 instant with timezone, such as 2026-10-09T08:00:00+08:00.';
// Gateway usage attribution. Every WorkLite call through the Gateway declares one
// surface, so these filters select exactly one platform feature's traffic and the same
// names work on statistics and request details throughout their configured retention windows.
const GATEWAY_SURFACES = ['chat', 'chat_project_task', 'agent', 'workflow', 'coder', 'coder_project_task', 'provider_test', 'external', 'unattributed'];
const GATEWAY_STATS_GROUP_BYS = ['surface', 'conversation', 'executor', 'coder', 'workflow', 'team_run', 'node_run', 'agent_run'];
const GATEWAY_ATTRIBUTION_TOOL_FILTERS = {
  surface: { type: 'string', enum: [...GATEWAY_SURFACES], description: 'Platform feature the request came from. chat is the Chat model loop, chat_project_task its historical project tasks, coder a Coder role loop, coder_project_task a Coder role running on an execution engine, unattributed a request that reached the Gateway without attribution.' },
  conversationId: toolString('Chat conversation (Agent execution) id; matches both its model loop and its project tasks.'),
  agentRunId: toolString('Exact Agent invocation id (air_..., or aex_... for direct execution), or comma-separated ids. Does not implicitly include descendants.'),
  agentExecutionId: toolString('Owning Agent execution id (aex_...); includes its model loops and executors across the invocation tree.'),
  projectTaskId: toolString('Chat project task id.'),
  executor: { type: 'string', enum: ['claude', 'codex'], description: 'Execution engine that issued the request.' },
  coderId: toolString('Coder id from inspect_coders.'),
  teamRunId: toolString('Coder Run id, or a comma-separated list of Run ids.'),
  workflowId: toolString(),
  workflowRunId: toolString(),
  nodeRunId: toolString('Node id: a Coder role task attempt id (from inspect_coder_run tasks) or a Workflow node run id; accepts a comma-separated list.'),
};

const WORKLITE_PLATFORM_TOOL_SPECS: Array<[path: string, description: string, inputSchema: Record<string, unknown>]> = [
  ['scripts/upload-local-files.mjs', 'Register existing local files as persistent workspace Artifacts. Accepts 1-8 regular files of any type as opaque attachments, at most 20 MB each and 40 MB total (WorkLite budgets, not verified iLink limits). Returns data.files with original sanitized basename, sizeBytes, contentUrl and markdown. Include each returned markdown verbatim in the reply for native WeChat file delivery in source order. Absolute paths only; no traversal or symlinks except macOS system aliases. A failed batch registers no records. Registration is not delivery.', toolInput({
    files: { type: 'array', minItems: 1, maxItems: 8, items: toolInput({
      path: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^/', description: 'Existing absolute file path on the API host; input only, never echoed.' },
    }, ['path']) },
  }, ['files'])],
  ['scripts/upload-local-images.mjs', 'Register existing local images as persistent Artifacts in the current workspace and return images with id, name, MIME type, dimensions, sizeBytes, contentUrl and ready-to-render markdown. Include that markdown verbatim in the reply to display images directly in Web Chat. Accepts 1-8 PNG/JPEG/GIF/WebP regular files, 10 MB each, 40 MB per batch, edge <=16384 and <=40 million pixels. Bytes and decoding determine the type. Absolute paths only; traversal and symlinks are rejected except macOS system directory aliases. A failed batch registers no records. Source paths and internal storage keys are never returned.', toolInput({
    files: { type: 'array', minItems: 1, maxItems: 8, items: toolInput({
      path: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^/', description: 'Existing absolute image path on the API host; input only, never echoed.' },
      description: { type: 'string', minLength: 1, maxLength: 200, pattern: String.raw`^[^/\\\x00-\x1f\x7f\u2028\u2029]+$`, description: 'Optional single-line image description, without path separators. Defaults to an image number.' },
    }, ['path']) },
  }, ['files'])],
  ['scripts/refresh-agent-action.mjs', 'Refresh the exact pending Agent authorization actionId when the user requests a fresh code. Returns qrImage.markdown for native image delivery, scanUrl for the same session and expiresAt. Share the returned markdown verbatim; a waiting authorization is not task completion.', toolInput({ actionId: toolString() }, ['actionId'])],
  ['scripts/create-agent.mjs', 'Create a persistent Agent requested by the user. Choose native, Codex or Claude Code execution; configure a saved provider/model or collaboration.publicModels for native execution. Collaboration is optional for a standalone Agent. Native Agents support collaboration.privateTools, persisted as tools/*.yaml in their own ~/.worklite/agents package, never in the shared Skills catalog. Agent prompts and metadata persist in AGENT.md; child Agents persist in subagents/.', toolInput({ parentAgentId: toolString('Optional parent Agent id; the sub-Agent is created and assigned atomically.'), runtime: { type: 'object' }, providerId: { type: ['string', 'null'], description: 'Saved provider id from inspect_workspace; null clears the provider.' }, model: toolString('Model configured on the selected provider.'), name: toolString(), responsibility: toolString(), systemPrompt: toolString(), collaboration: { type: 'object' }, skillIds: { type: 'array', items: { type: 'string' } }, mcpServerIds: { type: 'array', items: { type: 'string' } } }, ['name', 'responsibility', 'systemPrompt'])],
  ['scripts/update-agent.mjs', 'Update Agent metadata, model or execution settings after reading current configuration. Private children require parentAgentId. Omitted fields are preserved. To add or change private Skills or Tools, use run_host_command to write the owning Agent package files directly; do not install new abilities through this API.', toolInput({ parentAgentId: toolString('Owning Agent id when updating a private sub-Agent.'), agentId: toolString(), runtime: { type: 'object' }, providerId: { type: ['string', 'null'], description: 'Saved provider id from inspect_workspace; null clears the provider.' }, model: toolString('Model configured on the selected provider.'), name: toolString(), responsibility: toolString(), systemPrompt: toolString(), collaboration: { type: ['object', 'null'] }, skillIds: { type: 'array', items: { type: 'string' } }, mcpServerIds: { type: 'array', items: { type: 'string' } } }, ['agentId'])],
  ['scripts/cancel-agent-execution.mjs', 'Stop a user Agent task when the user asks to stop/cancel it. Supply its exact owning agentId and aex_ executionId from the launch receipt or saved records. Omit runId to cancel the entire execution and its descendants; supply an exact air_ child runId to cancel only that child subtree, leaving the lead and siblings active. Running or waiting work becomes cancelled, existing evidence is retained, and interrupted work is never automatically replayed. Do not dispatch an Agent to stop it.', toolInput({ agentId: toolString('Owning Agent id.'), executionId: toolString('Exact aex_ execution id.'), runId: toolString('Optional exact air_ child invocation id from the owning history.') }, ['agentId', 'executionId'])],
  ['scripts/delete-agent.mjs', 'Delete an Agent definition when explicitly requested. For a private child provide parentAgentId; all owned descendants are deleted in the same operation. Active executions must be cancelled first. Execution history is retained.', toolInput({ parentAgentId: toolString('Owning Agent id for a private sub-Agent.'), agentId: toolString() }, ['agentId'])],
  ['scripts/inspect-workspace.mjs', 'Read the workspace snapshot: configured Providers and models, Skills, MCP servers, Workflows, Coders, runtime profiles, the WorkLite project root and capability metadata, including capabilities.workflow.supportedNodeTypes. Call it before answering about configured resources or Workflow capabilities.', toolInput()],
  ['scripts/inspect-workflow.mjs', 'Read one Workflow directly from the platform instead of delegating: metadata and state, schedule, Home dashboard projection, the current draft revision with its full graph (nodes: id, type, typeVersion, config, position, errorPolicy; edges: source, target, sourcePort, targetPort, condition, maxTraversals), defaults and input example, the published version list with immutable definitions controlled by versions ("latest" by default, "all", or "none"), and recent Run summaries (runId, status, startedAt, finishedAt). Identify the Workflow by workflowId, or by an exact name that must be unique. Output is bounded; a truncation marker lists every omitted version definition, Run or graph item. Use it for any platform fact about one Workflow, never a Coder Run.', toolInput({
    workflowId: toolString('Workflow id from inspect_workspace or a previous result.'),
    name: toolString('Exact Workflow name when the id is unknown; it must be unique.'),
    includeDraft: { type: 'boolean', description: 'Include the current draft graph; defaults to true. Defaults and input are still returned when false.' },
    versions: { type: 'string', enum: ['latest', 'all', 'none'], description: 'Full immutable definitions to include: latest (default) only the newest published version, all every published version, none metadata only.' },
    runLimit: { type: 'integer', minimum: 0, maximum: 20, description: 'Recent Run summaries to return; defaults to 5.' },
  })],
  ['scripts/query-platform.mjs', 'Query the internal WorkLite platform API for platform facts when no dedicated typed tool covers the route. Supported read-only GET prefixes: /workflows, /workflow-versions, /runs (an array of every Run by default; paged=1 or cursor with workflowId and limit returns { items, nextCursor } pages; latestSucceededPerWorkflow=1 returns the newest succeeded Run of each Workflow on its latest published version), /artifacts, /home/board-categories, /skills, /mcp-servers, /portkey-gateway, /coders (Coder list, detail, roles, /coders/:coderId/runs and /coders/:coderId/memories), /coder-groups, /coder-runs (including /coder-runs/status-counts: queued and active Run counts per Coder), /coder-documents, /chat/conversations, /chat/project-tasks, /chat/memories, /chat/channels, /usage, /audit-logs, /api-request-logs (local WorkLite API request timings kept for 3 days by default: the list filters by from, to, method, route, minDurationMs and statusClass and pages with nextCursor; /api-request-logs/stats ranks non-streaming routes by p95 duration), /platform/snapshot, /settings and /local-projects. Event streams are not supported. Large responses include a truncation marker with a bounded preview.', toolInput({
    method: { type: 'string', enum: ['GET'], description: 'Only GET is allowed; omit it for GET.' },
    path: toolString('Site-relative path beginning with /, such as /workflows or /workflow-versions/:versionId. Pass query parameters through query.'),
    query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Optional flat scalar query parameters, such as limit or workflowId.' },
    cursor: toolString('Pagination cursor from a previous page; sent as the cursor query parameter.'),
  }, ['path'])],
  ['scripts/web-fetch.mjs', 'Fetch one public http(s) page and return its readable text with the page title. Redirects, response size and time are bounded, and the text is truncated with an explicit marker when it exceeds maxChars. Use it to read a known public URL; do not delegate web reading to a Coder Run.', toolInput({
    url: toolString('Absolute http or https URL.'),
    maxChars: { type: 'integer', minimum: 500, maximum: 20000, description: 'Maximum extracted characters; defaults to 8000.' },
  }, ['url'])],
  ['scripts/search-local-projects.mjs', 'Locate local project directories from a read-only, metadata-only index when the user names a project or keyword without an absolute path. Returns matching absolute paths with directory name, repository name, display name/description, git remote, current branch, ownership category (company, self, temp, forks, other), score, match reasons, matchedVia ("alias" or "metadata"), and for alias hits the alias and any note. Use it before dispatch_task to resolve the project, then choose a Coder by its current configuration and the task. A user-stated alias is ranked above every metadata field; when an alias target no longer exists the entry is returned with missing: true and a note explaining that the path is stale, so tell the user instead of using it. When nothing matches it returns approximate candidates, which may include alias candidates, and the total indexed project count, so "not indexed" is distinguishable from "does not exist".', toolInput({
    query: toolString('Fuzzy project name or keyword, such as a directory name, repository name, description term, remote path fragment or a user-stated alias.'),
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum matches to return; defaults to 10.' },
    refresh: { type: 'boolean', description: 'Force a fresh bounded metadata scan instead of using the cached index.' },
  }, ['query'])],
  ['scripts/list-local-project-aliases.mjs', 'List the saved project alias dictionary: the alias file path plus every alias, its absolute target directory, note and timestamps, with missing: true when the target directory no longer exists. Pass query to filter by alias, path or note. Aliases record only mappings the user explicitly stated between a spoken project name and a local directory.', toolInput({
    query: toolString('Optional case-insensitive filter over the alias, target path and note.'),
  })],
  ['scripts/set-local-project-alias.mjs', 'Record or update one user-stated mapping from a spoken project name to an existing local directory. Use it only when the user explicitly says that a name refers to a directory (for example "dino-datahub 其实就是 company/dino/dino-app"); never guess a mapping, never infer one from a similar name, and never generate aliases in bulk. The alias is case-insensitive and unique; saving the same alias again replaces its target and note. The target must be an existing directory inside the local project root. This tool writes only the alias dictionary file: it never changes project code, reads source files or performs Git operations.', toolInput({
    alias: toolString('The spoken project name exactly as the user says it; Chinese names are allowed.'),
    absolutePath: toolString('Absolute path of the existing target directory. A path relative to the local project root is also accepted.'),
    note: toolString('Optional short note, such as why the name differs from the directory name.'),
  }, ['alias', 'absolutePath'])],
  ['scripts/remove-local-project-alias.mjs', 'Remove one saved project alias when the user says the mapping is wrong or obsolete. This only deletes the dictionary entry; the target directory and any project files or Git state remain untouched.', toolInput({
    alias: toolString('The saved alias to remove, matched case-insensitively.'),
  }, ['alias'])],
  ['scripts/inspect-chat.mjs', 'Read the protected Chat configuration: revision, runtime, Chat extension prompt, conversation-completion host notification settings, Provider/model and Skill ids. Chat Skill ids are captured by value per turn; user MCP cannot be called directly by Chat. Its revision is the expectedConfigurationRevision for update_chat.', toolInput()],
  ['scripts/update-chat.mjs', 'Save a new Chat configuration revision. Runtime selection applies to new conversations; Skills and prompts apply from the next turn. Omitted fields keep their current value. turnNotificationsEnabled and turnNotificationSound control the macOS host notification posted when a conversation turn settles, and apply immediately rather than from the next turn. skillIds replaces the full Chat Skill id list: every id must exist in this workspace\'s Skill registry and be valid, or the call fails with no partial write; omit it to keep the current list. This tool still does not edit Chat-facing user MCP selection; Chat cannot call user MCP directly.', toolInput({
    expectedConfigurationRevision: { type: 'integer', minimum: 1, description: 'The revision returned by inspect_chat.' },
    runtime: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['native', 'codex', 'claude'] } }, description: 'Runtime for new Chat conversations. Working directory is managed by WorkLite.' },
    extensionPrompt: toolString('User extension appended to the product prompt.'),
    turnNotificationsEnabled: { type: 'boolean', description: 'Post a macOS system notification on the WorkLite host when a Chat conversation turn completes, fails or waits for user input. Enabled by default; it has no effect on a non-macOS host.' },
    turnNotificationSound: { type: 'string', description: 'System sound name for that notification (Glass, Ping, Hero, Submarine, Blow, Bottle, Frog, Funk, Morse, Pop, Purr, Sosumi, Tink); an empty string notifies silently.' },
    providerId: { type: ['string', 'null'], description: 'Provider id from inspect_workspace, or null for the default.' },
    model: toolString('Model id offered by the selected Provider.'),
    skillIds: toolStrings('Full replacement list of Skill ids for Chat; every id must exist in this workspace and be valid. Omit to keep the current list.'),
  }, ['expectedConfigurationRevision'])],
  ['scripts/inspect-chat-conversations.mjs', 'List persisted Chat conversations from Web and Feishu, newest first.', toolInput({
    cursor: toolString('nextCursor from a previous page.'),
    search: toolString('Text to match in conversation content.'),
    channel: toolString('Channel id, such as web or feishu.'),
  })],
  ['scripts/inspect-chat-conversation.mjs', 'Read one Chat conversation. records: true adds status events and channel receipt diagnostics (the newest 500 channel events, with receiptsTotal counting all of them); successful snapshot outputs are replaced by references, and toolCallId returns one full retained tool call. fullRecordsRoute names the complete raw records.', toolInput({
    conversationId: toolString('Conversation (execution) id.'),
    records: { type: 'boolean', description: 'Include diagnostic status and receipt records.' },
    toolCallId: toolString('Return only this tool call with its full output.'),
  }, ['conversationId'])],
  ['scripts/start-chat-conversation.mjs', 'Start a separate background Chat conversation that runs the message as its first request without user activation, and return its conversationId. The message is shown as that conversation\'s first user message with a note naming this conversation as its origin; it runs on the current Chat configuration and appears in Chat history. A conversation started this way cannot start another one. Follow it with wait_chat_conversation and answer its questions with message_chat_conversation.', toolInput({
    message: toolString('Complete self-contained request for the background conversation, including goal, workspace directory (which may contain multiple projects), executor and constraints; it does not see this conversation.'),
  }, ['message'])],
  ['scripts/wait-chat-conversation.mjs', 'Monitor a Chat conversation. Returns early whenever its visible progress changes (a plan step advances, a new message arrives, or the active tool call changes), reporting what it is doing now: status, plan step states, the active tool call with its name and elapsed seconds, and the latest messages. Also returns when it completes, fails or waits for input, and at the timeout. Call it again to keep watching; read details with inspect_chat_conversation.', toolInput({
    conversationId: toolString('Conversation (execution) id.'),
    timeoutSeconds: { type: 'integer', minimum: 5, maximum: 1800, description: 'Maximum wait; defaults to 600.' },
  }, ['conversationId'])],
  ['scripts/message-chat-conversation.mjs', 'Send a message into a background conversation started from this conversation: it answers the pending question when the conversation waits for input, otherwise it continues the conversation as the next user message. It fails while that conversation is running and for interrupted-operation recovery questions, which stay with the user.', toolInput({
    conversationId: toolString('Background conversation id returned by start_chat_conversation.'),
    message: toolString('Answer or next request.'),
  }, ['conversationId', 'message'])],
  ['scripts/inspect-project-task.mjs', 'Read a conversation-owned project task: executor, status, result, error, progressText (latest complete public reply), activity phase counts and the latest 20 activity summaries of the executor\'s commands, file changes and tool calls. Tasks recorded before native Coders also list operation summaries; pass operationKey only when one such operation\'s full retained input and output are needed.', toolInput({
    taskId: toolString(),
    operationKey: toolString('One operation key from the task summary.'),
  }, ['taskId'])],
  ['scripts/list-project-tasks.mjs', 'List project tasks workspace-wide, including tasks owned by other conversations: id, goal, owning conversation, project directory, executor, model, status, stage, latest progress text, activity count, historical worktree and merge evidence. Use it to find a task before inspect_project_task, subscribe_project_task or wait_project_task. These are historical Chat project tasks created before project work moved to Coders; Chat no longer creates them.', toolInput({
    status: { type: 'string', enum: ['active', 'settled', 'all'], description: 'Defaults to all; active means running or waiting for input.' },
    limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Defaults to 50, most recently updated first.' },
  })],
  ['scripts/subscribe-project-task.mjs', 'Subscribe this conversation to another conversation\'s project task: when the task next succeeds, fails or waits for input, its outcome is reported into this conversation in an automatic brief reply. The subscription is one-shot and is consumed by that report; subscribe again after answering a task question if the re-run still matters.', toolInput({
    taskId: toolString('Task id from list_project_tasks or inspect_project_task.'),
  }, ['taskId'])],
  ['scripts/wait-project-task.mjs', 'Watch one project task without polling. Returns as soon as its visible progress changes (status, stage, activity count or latest progress text), when it settles or waits for input, and at the timeout. Call it again to keep watching; read details with inspect_project_task.', toolInput({
    taskId: toolString(),
    timeoutSeconds: { type: 'integer', minimum: 5, maximum: 1800, description: 'Maximum wait; defaults to 600.' },
  }, ['taskId'])],
  ['scripts/inspect-agent-run.mjs', 'Read token usage by recorded air_ runId or owning aex_ executionId; no agentId is needed. Includes its invocation tree, saved runtime token usage (input includes cache), and separate overlapping Gateway-only summary/groups split by invocation and executor. Historical missing attribution is unknown, not zero; never add Gateway totals to runtime usage.', toolInput({ runId: toolString() }, ['runId'])],
  ['scripts/inspect-gateway-stats.mjs', 'Read Gateway request statistics for an absolute time range (GATEWAY_STATS_RETENTION_DAYS, default 90 days; 0 retains indefinitely). Use agentRunId for exact invocations, agentExecutionId for an execution tree, and groupBy agent_run to separate model loops and executors. Only Gateway traffic is counted; direct-provider traffic is runtime-only. Historical missing attribution cannot be recovered by time overlap.', toolInput({
    from: toolString(ABSOLUTE_INSTANT),
    to: toolString(ABSOLUTE_INSTANT),
    groupBy: { type: 'string', enum: [...GATEWAY_STATS_GROUP_BYS], description: 'Group by surface (default), conversation, executor, coder, workflow, team_run, node_run or agent_run. agent_run carries agentRunId, agentExecutionId and executor; a null executor means the Agent model/capability loop.' },
    ...GATEWAY_ATTRIBUTION_TOOL_FILTERS,
  }, ['from', 'to'])],
  ['scripts/inspect-gateway-request-logs.mjs', 'List captured Gateway request logs for an absolute time range. Request details expire after GATEWAY_REQUEST_LOG_RETENTION_HOURS (default 12 hours), so the result reports retainedFrom and retentionHours; read them before concluding that no failure occurred. Each item carries its attribution surface and identifiers. Keep the same range and filters when following nextCursor. For usage beyond the retention window use inspect_gateway_stats instead.', toolInput({
    from: toolString(ABSOLUTE_INSTANT),
    to: toolString(ABSOLUTE_INSTANT),
    provider: toolString('Provider name.'),
    model: toolString('Public model id.'),
    statusClass: { type: 'string', enum: ['success', 'client_error', 'server_error'] },
    ...GATEWAY_ATTRIBUTION_TOOL_FILTERS,
    limit: { type: 'integer', minimum: 1 },
    cursor: toolString('nextCursor from the previous page.'),
  }, ['from', 'to'])],
  ['scripts/inspect-gateway-request-log.mjs', 'Read one captured Gateway request with its complete request and response, streaming events, or the reason it is unavailable.', toolInput({
    requestLogId: toolString(),
  }, ['requestLogId'])],
  ['scripts/create-provider.mjs', 'Create a model Provider draft. The protocol must be chosen explicitly and is never defaulted. System One model ids are entered manually because it has no discovery endpoint.', toolInput({
    name: toolString('Unique Provider name; it becomes the prefix of public model ids.'),
    protocol: { type: 'string', enum: ['openai/chat', 'openai/responses', 'anthropic/messages', 'codex/responses', 'typesafe/systemone'] },
    baseURL: toolString(),
    models: toolStrings('Model ids offered by the Provider.'),
  }, ['name', 'protocol', 'baseURL', 'models'])],
  ['scripts/discover-provider-models.mjs', 'Fetch upstream model ids for an already saved Provider using its stored credentials. Returns model ids only and does not reveal the API key. System One has no model-discovery endpoint.', toolInput({
    providerId: toolString('Saved Provider id returned by query_platform GET /portkey-gateway/providers.'),
  }, ['providerId'])],
  ['scripts/update-provider-models.mjs', 'Add one or more model ids to an existing Provider without replacing its current models. Returns the merged model list and Provider id only; credentials are never returned.', toolInput({
    providerId: toolString('Saved Provider id returned by query_platform GET /portkey-gateway/providers.'),
    addModels: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 240 }, description: 'Model ids to add. Existing ids are kept and duplicates are removed.' },
  }, ['providerId', 'addModels'])],
  ['scripts/create-skill.mjs', 'Create a Skill package. The files must include a root SKILL.md containing the instructions; text files may also live under scripts/ (executable only with a shebang) and references/.', toolInput({
    name: toolString(),
    files: { type: 'array', minItems: 1, maxItems: 100, items: toolInput({ path: toolString('Relative path, such as SKILL.md or scripts/run.sh.'), content: toolString() }, ['path', 'content']) },
  }, ['name', 'files'])],
  ['scripts/create-mcp-server.mjs', 'Create a remote MCP server. The server connects and discovers its tools automatically on creation and when first referenced; without an explicit tool selection every discovered tool is allowed. The returned resource carries the connection state, a persisted failure reason when connection fails, and the discovered tool names.', toolInput({
    name: toolString(),
    endpoint: toolString('Remote MCP endpoint URL.'),
  }, ['name', 'endpoint'])],
  ['scripts/delete-mcp-server.mjs', 'Permanently delete a workspace MCP server. Set confirm to true. Deletion is reference-protected: a referenced server is rejected with every concrete location (Workflow drafts and published versions with node ids, Coder roles and captured versions, active Chat turns, legacy Agent assignments). force defaults to false; with force: true the same call removes the reference from every Workflow draft and every active Coder role in one transaction before deleting. Immutable published WorkflowVersions and capturedVersions keep their historical ids; re-running one then reports the server as unavailable. References from an active Chat turn or a legacy Agent assignment always block deletion, even with force.', toolInput({
    mcpServerId: toolString('MCP server id from inspect_workspace.'),
    confirm: { type: 'boolean', description: 'Set true to confirm permanent deletion.' },
    force: { type: 'boolean', description: 'Defaults to false. With true, references in Workflow drafts and active Coder roles are removed in place as part of the deletion.' },
  }, ['mcpServerId', 'confirm'])],
  ['scripts/create-workflow.mjs', 'Create an empty Workflow draft and return its id and editor route. Build its graph with edit_workflow.', toolInput({
    name: toolString(),
  }, ['name'])],
  ['scripts/edit-workflow.mjs', [
    'Replace a Workflow draft graph from a logical plan; the tool fetches the current draft revision itself and returns the authoritative Workflow.',
    'Use only node types, versions, ports and config schemas from inspect_workspace capabilities.workflow.supportedNodeTypes, and set typeVersion "2" for a WeChat v2 node. Node keys are local to the plan; omit node ids and positions. Omit a port only when the node has one unambiguous output or required input.',
    'Edges are unconditional, predicate (dot-delimited output path, operator, value) or fallback. A fallback runs only when no other edge from that invocation matches; worklite/branch@1 takes the first matching predicate in plan order, then the first fallback. maxTraversals bounds an edge, and every cycle must cross a bounded edge. An Agent context accepts one unbounded initial edge plus one bounded feedback edge; a Workflow Input edge is unconditional and unbounded.',
    'Use at most one worklite/timer (intervalSeconds of at least 300, active after publish, never combined with WeChat publish mode) and at most one worklite/dashboard with a connected data input.',
    'Editorial publishing routes every review result through the required context input of worklite/approved-article@1 before a Markdown-format Artifact or WeChat node; a JSON reviewer returns only its verdict and copies writer fields with passthroughKeys. Never route a rejected review directly to an Artifact or WeChat.',
    'TypeSafe nodes use a public <providerName>/<modelId>, typed questions and a JSON state input. Agent nodes may use only WorkLite platform Skills and may set requiredSkillIds (a subset of skillIds whose scripts must each succeed at least once, meaning exit 0 without printing ok: false JSON, or the node fails), outputFormat json, outputContract, passthroughKeys, maxToolCalls, maxToolRounds, maxToolResultChars and maxOutputTokens (per-response ceiling, thinking included; default 64000 for Anthropic models, 32768 otherwise). ',
  ].join(' '), toolInput({
    workflowId: toolString(),
    sourceInstruction: { type: 'string', maxLength: 4000, description: 'One sentence describing the requested change, recorded on the edit revision.' },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['nodes', 'edges'],
      properties: {
        nodes: { type: 'array', items: toolInput({
          key: toolString('Plan-local key referenced by edges.'),
          type: toolString('Node type from supportedNodeTypes, such as worklite/agent.'),
          typeVersion: toolString(),
          config: { type: 'object', description: 'Configuration matching the node type schema; use {} when it has none.' },
          errorPolicy: { type: 'string', enum: ['stop', 'retry'] },
        }, ['key', 'type', 'config']) },
        edges: { type: 'array', items: toolInput({
          source: toolString('Source node key.'),
          target: toolString('Target node key.'),
          sourcePort: toolString(),
          targetPort: toolString(),
          condition: { anyOf: [
            toolInput({ kind: { type: 'string', enum: ['predicate'] }, path: toolString('Dot-delimited output path, such as $.approved.'), operator: { type: 'string', enum: ['equals', 'notEquals', 'truthy', 'falsy', 'exists', 'notExists', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'] }, value: {} }, ['kind', 'path', 'operator']),
            toolInput({ kind: { type: 'string', enum: ['fallback'] } }, ['kind']),
          ] },
          maxTraversals: { type: 'integer', minimum: 1 },
        }, ['source', 'target']) },
        input: toolInput({ example: {} }),
        defaults: toolInput({ errorPolicy: { type: 'string', enum: ['stop', 'retry'] } }, ['errorPolicy']),
      },
    },
  }, ['workflowId', 'sourceInstruction', 'plan'])],
  ['scripts/patch-workflow.mjs', [
    'Edit an existing Workflow draft in place with an ordered patch and return the authoritative Workflow. Nodes and edges the patch does not mention keep their ids, positions and configuration; prefer this over edit_workflow, which regenerates every id.',
    'Call inspect_workflow first to read node and edge ids and the draft revisionId. baseRevisionId is optional; when omitted the tool reads the current draft revision itself, and a stale revision is rejected with a conflict.',
    'updateNode changes one node: config replaces the whole configuration, configPatch shallow-merges top-level keys into the current configuration (nested objects and arrays are replaced as a whole), and errorPolicy may change alone.',
    'addNode takes a patch-local key that later addEdge entries may reference; position defaults to below the existing nodes. addEdge source and target are existing node ids or such keys; ports, conditions and maxTraversals follow the edit_workflow rules. removeNode also removes its edges. updateSettings changes input or defaults.',
    'Agent nodes may set requiredSkillIds, a subset of skillIds: the node then fails unless every listed Skill has at least one script call that succeeded during the node attempt (exited 0 and did not print a JSON object with ok: false), so downstream nodes do not run under errorPolicy stop.',
    'The server validates the whole resulting graph and records one undoable revision; published versions and historical Runs do not change.',
  ].join(' '), toolInput({
    workflowId: toolString(),
    baseRevisionId: toolString('Optional draft revisionId from inspect_workflow; omitted means the current draft revision.'),
    sourceInstruction: { type: 'string', maxLength: 4000, description: 'One sentence describing the requested change, recorded on the edit revision.' },
    patch: { type: 'array', minItems: 1, items: { anyOf: [
      toolInput({ op: { type: 'string', enum: ['updateNode'] }, nodeId: toolString('Existing node id.'), config: { type: 'object', description: 'Full replacement configuration; excludes configPatch.' }, configPatch: { type: 'object', description: 'Top-level keys shallow-merged into the current configuration; excludes config.' }, errorPolicy: { type: 'string', enum: ['stop', 'retry'] } }, ['op', 'nodeId']),
      toolInput({ op: { type: 'string', enum: ['addNode'] }, key: toolString('Patch-local key for later addEdge entries.'), type: toolString('Node type from supportedNodeTypes.'), typeVersion: toolString(), config: { type: 'object', description: 'Configuration matching the node type schema; use {} when it has none.' }, errorPolicy: { type: 'string', enum: ['stop', 'retry'] }, position: toolInput({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) }, ['op', 'key', 'type', 'config']),
      toolInput({ op: { type: 'string', enum: ['removeNode'] }, nodeId: toolString('Existing node id.') }, ['op', 'nodeId']),
      toolInput({
        op: { type: 'string', enum: ['addEdge'] },
        source: toolString('Existing node id or patch-local key.'),
        target: toolString('Existing node id or patch-local key.'),
        sourcePort: toolString(),
        targetPort: toolString(),
        condition: { anyOf: [
          toolInput({ kind: { type: 'string', enum: ['predicate'] }, path: toolString('Dot-delimited output path, such as $.approved.'), operator: { type: 'string', enum: ['equals', 'notEquals', 'truthy', 'falsy', 'exists', 'notExists', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'] }, value: {} }, ['kind', 'path', 'operator']),
          toolInput({ kind: { type: 'string', enum: ['fallback'] } }, ['kind']),
        ] },
        maxTraversals: { type: 'integer', minimum: 1 },
      }, ['op', 'source', 'target']),
      toolInput({ op: { type: 'string', enum: ['removeEdge'] }, edgeId: toolString('Existing edge id.') }, ['op', 'edgeId']),
      toolInput({ op: { type: 'string', enum: ['updateSettings'] }, input: toolInput({ example: {} }), defaults: toolInput({ errorPolicy: { type: 'string', enum: ['stop', 'retry'] } }, ['errorPolicy']) }, ['op']),
    ] } },
  }, ['workflowId', 'sourceInstruction', 'patch'])],
  ['scripts/replace-workflow-agent-models.mjs', 'Replace one exact public model id with another on all or selected worklite/agent nodes in a Workflow draft. The tool fetches the current base revision itself; the server validates that the target model exists in the Provider catalog on an Agent-compatible protocol, preserves every other node config field, and records ordinary typed update operations. Published versions and historical Runs do not change.', toolInput({
    workflowId: toolString(),
    fromModel: toolString('Exact current public <providerName>/<modelId> to replace.'),
    toModel: toolString('Target public <providerName>/<modelId> from inspect_workspace; its Provider protocol must support Agent execution.'),
    nodeIds: { ...toolStrings('Optional Agent node ids to limit the repair; omitted means every matching Agent node.'), minItems: 1 },
    sourceInstruction: { type: 'string', maxLength: 4000, description: 'One sentence describing the repair, recorded on the edit revision.' },
  }, ['workflowId', 'fromModel', 'toModel'])],
  ['scripts/publish-workflow.mjs', 'Publish the current Workflow draft as its next immutable version. The server validates the graph and workspace references and synchronizes its Timer.', toolInput({
    workflowId: toolString(),
  }, ['workflowId'])],
  ['scripts/delete-workflow.mjs', 'Permanently delete a Workflow. Set confirm to true. force defaults to false and only bypasses active-schedule and Home-assignment guards; an active Run is always rejected. Related Artifacts remain available with detached references.', toolInput({
    workflowId: toolString(),
    confirm: { type: 'boolean', description: 'Set true to confirm permanent deletion.' },
    force: { type: 'boolean', default: false, description: 'Defaults to false. When true, bypass only active-schedule and Home board-assignment guards; it never bypasses the active-Run guard.' },
  }, ['workflowId', 'confirm'])],
  ['scripts/dispatch-task.mjs', 'Dispatch code work to a Coder by stable coderId with the complete goal and existing absolute projectDirectory. New Runs enter Router; requested roles stay in Router context. For other automation use inspect_agents and run_agent.', toolInput({ message: toolString(), target: toolInput({ kind: { type: 'string', enum: ['coder'] }, coderId: toolString(), projectDirectory: toolString(), role: toolString() }, ['kind', 'coderId', 'projectDirectory']) }, ['message', 'target'])],
  ['scripts/inspect-workflow-run.mjs', 'Read one Workflow Run by run id (not a Workflow id): status, ordered node runs with failures, the server-declared retryable node, the resumable flag, pending action and Artifacts. Never share a QR from this inspection result; use refresh_workflow_run_pending_action only when the user explicitly asks for a code, then check the refresh result pendingAction.status and expiresAt before sharing its qrCode. Run ids come from dispatch results, conversation-bound tasks and Gateway log correlation.', toolInput({
    runId: toolString(),
  }, ['runId'])],
  ['scripts/refresh-workflow-run-pending-action.mjs', 'Only when the user explicitly asks to get or refresh a WeChat Official Account QR, call this for the waiting Workflow Run after inspecting it. It posts to /runs/:runId/pending-action/refresh, returns the updated RunView with pendingAction.qrCode, and rejects a missing, expired or non-PNG code.', toolInput({
    runId: toolString('Workflow Run id from inspect_workflow_run.'),
  }, ['runId'])],
  ['scripts/inspect-wechat-draft.mjs', 'Read a WeChat Official Account draft that a Workflow Run saved, by its Run id and draft id together: publication status, current title, the article image keys in body order with the Artifact that currently fills each, past revisions and any revision that blocks a new one. With verify: true it also opens the draft in the account (read-only, no edit or save) and checks that its body text and image count still match the recorded article.', toolInput({
    runId: toolString('Workflow Run id that saved the draft.'),
    draftId: toolString('WeChat draft id (appmsgid) recorded by that Run.'),
    verify: { type: 'boolean', description: 'Also open the live draft read-only and compare it with the record. Takes up to a minute.' },
  }, ['runId', 'draftId'])],
  ['scripts/render-article-image.mjs', 'Render one replacement illustration for an image key of a saved WeChat draft from self-contained HTML and CSS (inline SVG and data: URIs allowed; JavaScript and network loads are disabled) and store it as a PNG Artifact of that Run. Returns the Artifact id, its content URL and layout issues: text past the image edge or cut off by its container (clipped), text spilling out of its box (overflow), text drawn over other text (overlap) or under another element (covered), the same text block shown twice (duplicate), and text under 20px at 1080px width (small_text). Only an image with no issues can be used by revise_wechat_draft.', toolInput({
    runId: toolString('Workflow Run id that saved the draft.'),
    draftId: toolString('WeChat draft id recorded by that Run.'),
    key: toolString('Image key from inspect_wechat_draft.'),
    html: toolString('Complete illustration as HTML with inline CSS, laid out for the given width and height.'),
    width: { type: 'integer', minimum: 1080, maximum: 2160, description: 'Defaults to 1080.' },
    height: { type: 'integer', minimum: 720, maximum: 2160, description: 'Defaults to 720.' },
  }, ['runId', 'draftId', 'key', 'html'])],
  ['scripts/revise-wechat-draft.mjs', 'Change the title and/or selected body images of a WeChat draft that a Workflow Run saved, keeping the article text exactly as recorded and the cover unchanged. WorkLite opens the draft, stops without changing it if its body no longer matches the record, uploads the replacement images, verifies the body text again and saves the same draft. Waits up to about 5 minutes for the result: saved, failed (draft unchanged) or uncertain (save was clicked but the result is unknown). Reusing the same requestKey returns the recorded result and never operates the account again.', toolInput({
    runId: toolString('Workflow Run id that saved the draft.'),
    draftId: toolString('WeChat draft id recorded by that Run.'),
    requestKey: toolString('Unique key for this revision request, 8-120 characters; reuse it only to re-read the same request.'),
    title: toolString('New title, at most 64 characters. Omit to keep the current title.'),
    imageReplacements: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of image key to an issue-free Artifact id from render_article_image.' },
  }, ['runId', 'draftId', 'requestKey'])],
  ['scripts/resolve-wechat-draft-revision.mjs', 'Record what the WeChat backend actually shows for a draft revision whose result was uncertain, after the user has checked the draft there. saved also updates the recorded title; not_saved marks it failed. Either one unblocks further revisions of that draft.', toolInput({
    runId: toolString('Workflow Run id that saved the draft.'),
    draftId: toolString('WeChat draft id recorded by that Run.'),
    revisionId: toolString('Uncertain revision id from revise_wechat_draft or inspect_wechat_draft.'),
    outcome: { type: 'string', enum: ['saved', 'not_saved'] },
    note: toolString('What the user saw in the WeChat backend.'),
  }, ['runId', 'draftId', 'revisionId', 'outcome', 'note'])],
  ['scripts/control-workflow-run.mjs', 'Pause a queued or running Workflow Run, resume a paused Run or a cancelled Run whose detail sets resumable: true, cancel it, or retry the one node run it marks retryable. Inspect the Run first.', toolInput({
    runId: toolString(),
    action: { type: 'string', enum: RUN_ACTIONS },
    nodeRunId: toolString('Required for retry: the retryable node run id.'),
  }, ['runId', 'action'])],
  ['scripts/inspect-coders.mjs', 'List active Coders with their ids, descriptions, roles and settings. Use the id to dispatch and configure a Coder.', toolInput()],
  ['scripts/create-coder.mjs', 'Create a persistent Coder with a Planner and Implementer, or copy an existing Coder configuration as a template. Configure its purpose, roles and settings with update_coder and role tools. No runs or memories are copied.', toolInput({
    name: toolString('Unique Coder display name.'),
    description: { type: 'string', description: 'Coder purpose and scope.' },
    templateCoderId: toolString('Optional existing Coder id whose configuration should be copied.'),
  }, ['name'])],
  ['scripts/inspect-coder.mjs', 'Read one Coder configuration: id, current name, revision, settings and every role.', toolInput({
    coderId: toolString(),
  }, ['coderId'])],
  ['scripts/update-coder.mjs', 'Update one Coder\'s name, working practice, project Git policy and/or concurrent Run limit. Pass coderId, never a name, to select it. A rename affects only Runs dispatched afterwards; existing Runs keep their captured Coder name. Use the dedicated role tools to change roles. New Runs capture the selected Coder settings and Git policy; the initial role alone receives the working-practice and full Coder-memory projections, every other role receives a bounded memory index, and every engine-backed role receives the Git policy plus per-task Coder memory tools.', toolInput({
    coderId: toolString(),
    name: { type: 'string', minLength: 1, maxLength: 64, description: 'New Coder display name: 1-64 characters after trimming, no control characters, unique among non-deleted Coders ignoring case (a duplicate is rejected with CODER_NAME_CONFLICT). Affects new Runs only; every Run keeps the name captured at dispatch.' },
    description: { type: 'string', description: 'Coder purpose and scope.' },
    expectedRevision: { type: 'integer', minimum: 0, description: 'Optional optimistic-lock precondition: the revision returned by inspect_coder. A stale value is rejected with CODER_REVISION_CONFLICT; inspect again and retry.' },
    workingPractice: { type: 'string', description: 'Coder working-practice text captured by new Runs and injected into Router context; historical Run evidence keeps its captured snapshot.' },
    projectGitPolicy: { type: 'string', description: 'Coder-specific Git guidance captured by new Runs and passed to engine-backed roles; Router decides task assignments and roles use their configured execution tools.' },
    maxConcurrentRuns: { type: 'integer', minimum: 1, description: 'Maximum number of concurrent Runs; additional Runs queue FIFO.' },
  }, ['coderId'])],
  ['scripts/delete-coder.mjs', 'Soft-delete one Coder after the user explicitly confirms. Rejected while the Coder has active Runs. Historical Runs, versions, memories and current group transcripts are preserved.', toolInput({
    coderId: toolString(),
    confirm: { type: 'boolean', description: 'Set true only after the user explicitly confirms the deletion.' },
  }, ['coderId', 'confirm'])],
  ['scripts/create-coder-role.mjs', 'Create a role in the selected Coder. The server assigns its stable role id; inspect the returned Coder before addressing it. New role configuration affects future Runs. An empty publicModelId uses the Coder default; a list is tried in order with Gateway fallback.', toolInput({
    coderId: toolString(),
    displayName: toolString('Human-readable role name.'),
    publicModelId: { type: ['string', 'array'], maxLength: 240, minItems: 1, items: { type: 'string', minLength: 1, maxLength: 240 }, description: 'Gateway public model id or an ordered list of candidate ids; later candidates are Gateway fallbacks. An empty string uses the Coder default.' },
    instructions: toolString(),
    entryPoints: toolStrings(),
    skillIds: toolStrings(),
    mcpServerIds: toolStrings(),
    toolNames: toolStrings(),
    executor: { type: 'string', enum: ['claude', 'codex'], description: 'Optional project executor engine; omit to use the WorkLite Agent. The selected model must use a protocol supported by the chosen engine.' },
  }, ['coderId', 'displayName', 'publicModelId', 'instructions'])],
  ['scripts/update-coder-role.mjs', 'Update one active Coder role by its role id from inspect_coder. Set executor to null to remove it from a non-Developer role; Developer always uses Claude Code or Codex. New settings apply to new Runs; existing Runs keep their captured role.', toolInput({
    coderId: toolString(),
    roleId: toolString('Role id from inspect_coder.'),
    displayName: toolString(),
    publicModelId: { type: ['string', 'array'], maxLength: 240, minItems: 1, items: { type: 'string', minLength: 1, maxLength: 240 }, description: 'Gateway public model id or an ordered list of candidate ids; later candidates are Gateway fallbacks. An empty string uses the Coder default.' },
    instructions: toolString(),
    entryPoints: toolStrings(),
    skillIds: toolStrings(),
    mcpServerIds: toolStrings(),
    toolNames: toolStrings(),
    executor: { type: ['string', 'null'], enum: ['claude', 'codex', null], description: 'Set null to remove the project executor engine from a non-Developer role. Developer stays engine-backed and defaults to Claude Code.' },
  }, ['coderId', 'roleId'])],
  ['scripts/delete-coder-role.mjs', 'Permanently remove one role from the active Coder configuration. Captured and historical Runs retain the role; Coder memories remain stored.', toolInput({
    coderId: toolString(),
    roleId: toolString('Role id from inspect_coder.'),
  }, ['coderId', 'roleId'])],
  ['scripts/inspect-coder-memories.mjs', 'List Coder-scoped memories, most recently updated first. An optional filter selects a canonical repository id. Coder memories are separate from Chat memories; Router receives the full bounded projection and assigned roles receive a bounded index. Roles can also search, read and write memories within the Run scope.', toolInput({
    coderId: toolString(),
    repositoryId: toolString('Canonical repository id from Coder group or memory data.'),
  }, ['coderId'])],
  ['scripts/create-coder-memory.mjs', 'Create a Coder memory through Chat, optionally scoped to a canonical repository. It is separate from Chat memory and is captured for the initial role of new Runs; roles can also write memories within the Run scope.', toolInput({
    coderId: toolString(),
    content: toolString(),
    repositoryId: { type: ['string', 'null'], description: 'Optional canonical repository id.' },
  }, ['coderId', 'content'])],
  ['scripts/update-coder-memory.mjs', 'Update one Coder memory by id, optionally changing its repository scope. The memory remains separate from Chat memory.', toolInput({
    coderId: toolString(),
    memoryId: toolString(),
    content: toolString(),
    repositoryId: { type: ['string', 'null'], description: 'Optional canonical repository id; null clears the repository scope.' },
  }, ['coderId', 'memoryId'])],
  ['scripts/delete-coder-memory.mjs', 'Delete one Coder memory by id. This does not delete workspace Chat memories.', toolInput({
    coderId: toolString(),
    memoryId: toolString(),
  }, ['coderId', 'memoryId'])],
  ['scripts/inspect-coder-records.mjs', 'List Coder Runs with intent, project directory, status and timestamps. Open one Run with inspect_coder_run for detailed progress and immutable evidence; group routes show current persisted transcripts.', toolInput({
    coderId: toolString(),
  }, ['coderId'])],
  ['scripts/inspect-coder-group.mjs', 'Read one Coder group transcript in persisted order, including role/repository scopes, immutable file references and bound Run ids. This tool is read-only; new work and all controls go through Chat task operations.', toolInput({
    groupId: toolString(),
  }, ['groupId'])],
  ['scripts/control-coder-group.mjs', 'Control a group-bound Coder Run. Inspect the Run and task attempts first. Use reexecute for a whole Run, stop_task for one active role task, or continue_task for one stopped or failed task with saved progress. If several tasks for a role are active, identify the exact taskAttemptId before control.', toolInput({
    groupId: toolString(),
    operation: { type: 'string', enum: ['reexecute', 'stop_task', 'continue_task'] },
    runIds: { type: 'array', minItems: 1, items: toolString('Run ids for reexecute.') },
    runId: toolString('The exact group-bound Run id for stop_task or continue_task.'),
    taskAttemptId: toolString('The exact role task attempt id for stop_task or continue_task.'),
  }, ['groupId', 'operation'])],
  ['scripts/inspect-coder-document.mjs', 'Read one immutable Coder document revision.', toolInput({
    documentId: toolString(),
  }, ['documentId'])],
  ['scripts/inspect-coder-run.mjs', 'Read a Coder Run: tasks, progress (phase, next step, percent complete, assignment completion, active Developers), pending inputs with ids and scope revisions, uncertain operations, native engine or Agent activity, and referenced platform Commands. Inspect a Run before answering, recovering, controlling or retrying it.', toolInput({
    runId: toolString(),
  }, ['runId'])],
  ['scripts/answer-coder-run.mjs', 'Answer a Coder Run\'s pending input using the pendingInputId and scopeRevision from inspect_coder_run. For a historical group Run that waits for project scope, optional absolute directories supplied by the user can bind that Run to those repositories.', toolInput({
    runId: toolString(),
    pendingInputId: toolString(),
    scopeRevision: { type: 'integer', minimum: 1 },
    answer: toolString(),
    directories: toolStrings('For historical group Runs waiting for project scope, optional absolute project directories supplied by the user.'),
  }, ['runId', 'pendingInputId', 'scopeRevision', 'answer'])],
  ['scripts/recover-coder-operation.mjs', 'Settle the current uncertain Coder operation with adopt_command, mark_failed or replay.', toolInput({
    runId: toolString(),
    operationKey: toolString(),
    decision: { type: 'string', enum: ['adopt_command', 'mark_failed', 'replay'] },
  }, ['runId', 'operationKey', 'decision'])],
  ['scripts/control-coder-run.mjs', 'Cancel a Coder Run. Use control_coder_group with continue_task to create a linked attempt for a stopped or failed role task, and recover_coder_operation only for an explicitly surfaced uncertain operation.', toolInput({
    runId: toolString(),
    action: { type: 'string', enum: CODER_RUN_ACTIONS },
  }, ['runId', 'action'])],
  ['scripts/propose-upgrade.mjs', 'Record a non-executing upgrade proposal that snapshots the current project into an immutable release manifest. Inspect the producing Codex task or Coder Run and its changes first. It does not deploy.', toolInput({
    summary: toolString('What the release contains and why.'),
  }, ['summary'])],
  ['scripts/redeploy.mjs', 'Redeploy WorkLite from the current project in this managed profile when requested. For a combined code-change and redeploy request, dispatch the change to a Coder first and call this after its Run reports success. Repeated calls in the same turn return the same job. Finish the turn after it starts and follow up with inspect_upgrade.', toolInput({
    summary: toolString('What is being deployed.'),
  }, ['summary'])],
  ['scripts/inspect-upgrade.mjs', 'Read an upgrade or redeploy job: release, phase and outcome.', toolInput({
    jobId: toolString(),
  }, ['jobId'])],
  ['scripts/update-settings.mjs', 'Change the persisted appearance setting.', toolInput({
    appearance: { type: 'string', enum: ['system', 'light', 'dark'] },
  }, ['appearance'])],
  ['scripts/navigate.mjs', 'Move the user\'s browser to a WorkLite page, or to a Workflow editor with /workflows/<workflowId-or-name>; a name must be unique.', toolInput({
    target: { anyOf: [
      { type: 'string', enum: NAVIGATION_TARGETS },
      { type: 'string', pattern: '^/workflows/.+', description: '/workflows/<workflowId-or-name>' },
    ] },
  }, ['target'])],
  ['scripts/list-memories.mjs', 'Read workspace long-term memories saved from earlier conversations, most recently updated first. Rule and preference memories are already injected into the prompt in full; other categories appear as a catalog, so filter by category or pass memoryId to read full text on demand — for project or development requests, read the project category before acting.', toolInput({
    category: { type: 'string', enum: ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'], description: 'Optional category filter.' },
    memoryId: toolString('Optional memory id from the prompt catalog or a previous list; returns that single entry\'s full text.'),
  })],
  ['scripts/save-memory.mjs', 'Save one durable user preference, fact or correction the user explicitly stated or asked to remember, so it applies to every later conversation. Do not save transient task details. The workspace holds at most 100 memories; when saving is rejected, list memories and delete an obsolete entry first.', toolInput({
    content: toolString('One self-contained memory in the user\'s language.'),
    category: { type: 'string', enum: ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'], description: 'Memory category; defaults to preference. rule and preference are always injected into the prompt; other categories are read on demand.' },
  }, ['content'])],
  ['scripts/update-memory.mjs', 'Replace the content and/or category of one saved long-term memory identified by its id from list_memories. At least one of content or category is required.', toolInput({
    memoryId: toolString('Memory id from list_memories.'),
    content: toolString('Replacement content.'),
    category: { type: 'string', enum: ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'], description: 'Replacement category.' },
  }, ['memoryId'])],
  ['scripts/delete-memory.mjs', 'Delete one saved long-term memory identified by its id from list_memories, when it is wrong or obsolete.', toolInput({
    memoryId: toolString('Memory id from list_memories.'),
  }, ['memoryId'])],
];

const WORKLITE_PLATFORM_RUNTIME_TOOL_SPECS: Array<[key: string, name: string, description: string, inputSchema: Record<string, unknown>]> = [
  ['__runtime__/run-host-command', 'run_host_command', 'Execute one complete local shell command through /bin/zsh -lc and return its exit code, stdout, stderr and duration. This is a general terminal with no command allow-list: pipelines, redirects, command substitution and arbitrary local CLIs are allowed. Use it for everyday installs, system/version information, CLI/query commands, ordinary file management and short local scripts that do not change repository source; use run_agent to an Agent for writing or changing code, repository-wide investigation, cross-file changes, validation/build/test, deployment or Coder workflows. cwd must be an absolute existing directory and defaults to the configured cwd or the user home. stdin is closed; requests that need a TTY fail or time out. Output, time and concurrency are bounded, and a timeout terminates the process group.', toolInput({
    command: { type: 'string', minLength: 1, maxLength: 20000, description: 'Complete zsh command. Shell syntax such as pipelines, redirects and substitutions is allowed.' },
    cwd: { type: 'string', maxLength: 4096, description: 'Optional absolute path to an existing accessible directory; omitted uses WORKLITE_CHAT_HOST_COMMAND_DEFAULT_CWD or the user home.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 900000, description: 'Optional per-call timeout in milliseconds; defaults to WORKLITE_CHAT_HOST_COMMAND_TIMEOUT_MS (120000) and is capped by WORKLITE_CHAT_HOST_COMMAND_MAX_TIMEOUT_MS, with a hard ceiling of 900000.' },
  }, ['command'])],
];

const WORKLITE_PLATFORM_TOOLS = Object.fromEntries([
  ...WORKLITE_PLATFORM_TOOL_SPECS.filter(([path]) => !path.includes('workflow') && !path.includes('coder') && path !== 'scripts/dispatch-task.mjs').map(([path, description, inputSchema]) => [path, {
    name: path.slice('scripts/'.length, -'.mjs'.length).replaceAll('-', '_'),
    description: path === 'scripts/inspect-workspace.mjs' ? 'Read configured Providers, Skills, MCP servers, Agents, sub-Agent assignments, capability tools.' : path === 'scripts/query-platform.mjs' ? 'Read platform facts through an allowed site-relative GET: /agents, /artifacts, /skills, /mcp-servers, /portkey-gateway, /chat, /usage, /audit-logs, /api-request-logs, /platform/snapshot, /settings or /local-projects. Responses redact secrets and bound large results.' : description.replaceAll('Workflow Run', 'Agent execution'),
    inputSchema,
  }]),
  ...WORKLITE_PLATFORM_RUNTIME_TOOL_SPECS.map(([key, name, description, inputSchema]) => [key, { name, description, inputSchema }]),
]);

const WORKLITE_PLATFORM_FILES: Array<[string, string]> = [
  ['SKILL.md', WORKLITE_PLATFORM_SKILL_MD],
  ['scripts/lib.mjs', WORKLITE_PLATFORM_LIB_MJS],
  ['scripts/upload-local-files.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print } from './lib.mjs';
const raw = input(); exactKeys(raw, ['files']);
const data = await call('/artifacts/local-files', { method: 'POST', body: raw });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/upload-local-images.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print } from './lib.mjs';
const raw = input(); exactKeys(raw, ['files']);
const data = await call('/artifacts/local-images', { method: 'POST', body: raw });
// Return the API payload. The execution boundary validates it and removes transport diagnostics.
print(data);
`],
  ['scripts/refresh-agent-action.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['actionId']);
const data = await call('/agent-actions/' + encodeURIComponent(requiredString(raw.actionId, 'actionId', 240)) + '/refresh', { method: 'POST', body: {} });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/create-agent.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print } from './lib.mjs';
const raw = input(); exactKeys(raw, ['parentAgentId', 'name', 'responsibility', 'systemPrompt', 'runtime', 'providerId', 'model', 'collaboration', 'skillIds', 'mcpServerIds']);
const data = await call('/agents', { method: 'POST', body: { providerId: null, model: '', skillIds: [], mcpServerIds: [], ...raw } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/update-agent.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['parentAgentId', 'agentId', 'runtime', 'providerId', 'model', 'name', 'responsibility', 'systemPrompt', 'collaboration', 'skillIds', 'mcpServerIds']);
const { agentId, parentAgentId, ...body } = raw;
const path = parentAgentId ? '/agents/' + encodeURIComponent(requiredString(parentAgentId, 'parentAgentId', 240)) + '/sub-agents/' + encodeURIComponent(requiredString(agentId, 'agentId', 240)) : '/agents/' + encodeURIComponent(requiredString(agentId, 'agentId', 240));
const data = await call(path, { method: 'PATCH', body });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/delete-agent.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['parentAgentId', 'agentId']);
const path = raw.parentAgentId ? '/agents/' + encodeURIComponent(requiredString(raw.parentAgentId, 'parentAgentId', 240)) + '/sub-agents/' + encodeURIComponent(requiredString(raw.agentId, 'agentId', 240)) : '/agents/' + encodeURIComponent(requiredString(raw.agentId, 'agentId', 240));
await call(path, { method: 'DELETE' });
print({ worklite: { type: 'snapshot' }, data: { deleted: true } });
`],
  ['scripts/inspect-chat.mjs', `#!/usr/bin/env node
import { call, noInput, print } from './lib.mjs';
noInput();
const data = await call('/agents/agt_system_helper_chat');
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/web-fetch.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['url', 'maxChars']);
const url = requiredString(raw.url, 'url', 2000);
if (raw.maxChars !== undefined && (!Number.isInteger(raw.maxChars) || raw.maxChars < 500 || raw.maxChars > 20000)) throw new Error('maxChars must be an integer from 500 to 20000.');
const data = await call('/web-search/fetch', { method: 'POST', body: { url, ...(raw.maxChars === undefined ? {} : { maxChars: raw.maxChars }) } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/search-local-projects.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, optionalString, print } from './lib.mjs';
const raw = input(); exactKeys(raw, ['query', 'limit', 'refresh']);
const query = optionalString(raw.query, 'query', 200);
if (!query) throw new Error('query is required.');
if (raw.limit !== undefined && (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 50)) throw new Error('limit must be an integer from 1 to 50.');
if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') throw new Error('refresh must be a boolean.');
const params = new URLSearchParams({ query });
if (raw.limit !== undefined) params.set('limit', String(raw.limit));
if (raw.refresh === true) params.set('refresh', 'true');
const data = await call('/local-projects/search?' + params.toString());
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/list-local-project-aliases.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, optionalString, print } from './lib.mjs';
const raw = input(false); exactKeys(raw, ['query']);
const query = optionalString(raw.query, 'query', 200);
const params = new URLSearchParams();
if (query) params.set('query', query);
const data = await call('/local-projects/aliases' + (params.size ? '?' + params.toString() : ''));
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/set-local-project-alias.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['alias', 'absolutePath', 'note']);
const alias = requiredString(raw.alias, 'alias', 120);
const absolutePath = requiredString(raw.absolutePath, 'absolutePath', 1024);
if (raw.note !== undefined && typeof raw.note !== 'string') throw new Error('note must be a string.');
const note = typeof raw.note === 'string' ? raw.note.trim() : '';
if (note.length > 500) throw new Error('note must be no longer than 500 characters.');
const data = await call('/local-projects/aliases', { method: 'PUT', body: { alias, absolutePath, ...(note ? { note } : {}) } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/remove-local-project-alias.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['alias']);
const alias = requiredString(raw.alias, 'alias', 120);
const data = await call('/local-projects/aliases/' + encodeURIComponent(alias), { method: 'DELETE' });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-chat-conversations.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print } from './lib.mjs';
const raw = input(); exactKeys(raw, ['cursor', 'search', 'channel']);
const query = new URLSearchParams();
for (const key of ['cursor', 'search', 'channel']) if (typeof raw[key] === 'string' && raw[key]) query.set(key, raw[key]);
const data = await call('/chat/conversations' + (query.size ? '?' + query.toString() : ''));
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-project-task.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, stringValue } from './lib.mjs';
const raw = input(); exactKeys(raw, ['taskId', 'operationKey']);
const id = stringValue(raw.taskId, 'taskId');
if (!id) throw new Error('taskId is required.');
const operationKey = raw.operationKey === undefined ? null : stringValue(raw.operationKey, 'operationKey');
const route = '/chat/project-tasks/' + encodeURIComponent(id);
// The task summary includes progressText and public text activities; operationKey selects retained historical operation evidence.
const data = await call(route + (operationKey ? '?operationKey=' + encodeURIComponent(operationKey) : ''));
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/list-project-tasks.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, stringValue } from './lib.mjs';
const raw = input(); exactKeys(raw, ['status', 'limit']);
const params = new URLSearchParams();
if (raw.status !== undefined) {
  const status = stringValue(raw.status, 'status');
  if (!['active', 'settled', 'all'].includes(status)) throw new Error("status must be 'active', 'settled' or 'all'.");
  params.set('status', status);
}
if (raw.limit !== undefined) {
  if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 200) throw new Error('limit must be an integer from 1 to 200.');
  params.set('limit', String(raw.limit));
}
const tasks = await call('/chat/project-tasks' + (params.size ? '?' + params.toString() : ''));
const clip = (value, max) => typeof value === 'string' && value.length > max ? value.slice(0, max - 1) + '…' : value;
print({ worklite: { type: 'snapshot' }, data: { tasks: tasks.map((task) => ({
  id: task.id, conversationId: task.executionId, goal: clip(task.goal, 200), projectDirectory: task.projectDirectory,
  executor: task.executor, model: task.model, status: task.status, stage: task.stage,
  progressText: clip(task.progressText, 300), activityCount: task.activityCount,
  worktreePath: task.worktreePath ?? null, worktreeBranch: task.worktreeBranch ?? null, baseBranch: task.baseBranch ?? null,
  mergeStatus: task.mergeStatus ?? null, updatedAt: task.updatedAt,
})) } });
`],
  ['scripts/subscribe-project-task.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['taskId']);
const taskId = requiredString(raw.taskId, 'taskId', 240);
const executionId = requiredString(process.env.WORKLITE_CHAT_EXECUTION_ID, 'server conversation context', 240);
const data = await call('/chat/project-tasks/' + encodeURIComponent(taskId) + '/subscribe', { method: 'POST', body: { executionId } });
print({ worklite: { type: 'snapshot' }, data: { taskId, ...data, oneShot: true } });
`],
  ['scripts/wait-project-task.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['taskId', 'timeoutSeconds']);
const taskId = requiredString(raw.taskId, 'taskId', 240);
const timeoutSeconds = raw.timeoutSeconds === undefined ? 600 : raw.timeoutSeconds;
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 1800) throw new Error('timeoutSeconds must be an integer from 5 to 1800.');
const deadline = Date.now() + timeoutSeconds * 1000;
const route = '/chat/project-tasks/' + encodeURIComponent(taskId);
const signature = (task) => JSON.stringify({ status: task.status, stage: task.stage, activityCount: task.activityCount, progressText: task.progressText });
const snapshot = (task, progressChanged) => ({
  taskId, status: task.status, stage: task.stage, settled: ['succeeded', 'failed', 'cancelled'].includes(task.status), progressChanged,
  progressText: task.progressText, activityCount: task.activityCount, latestActivities: (task.activities ?? []).slice(-3),
  pendingQuestion: task.pendingQuestion, result: task.result, error: task.error, mergeStatus: task.mergeStatus ?? null,
});
let task = await call(route);
let lastSignature = signature(task);
while (!['succeeded', 'failed', 'cancelled', 'waiting_for_input'].includes(task.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, deadline - Date.now()))));
  task = await call(route);
  const nextSignature = signature(task);
  // Return as soon as the task visibly advances so the watcher can report what it is doing now.
  if (!['succeeded', 'failed', 'cancelled', 'waiting_for_input'].includes(task.status) && nextSignature !== lastSignature) {
    print({ worklite: { type: 'snapshot' }, data: snapshot(task, true) });
    return;
  }
  lastSignature = nextSignature;
}
print({ worklite: { type: 'snapshot' }, data: snapshot(task, false) });
`],
  ['scripts/inspect-chat-conversation.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['conversationId', 'records', 'toolCallId']);
const id = requiredString(raw.conversationId, 'conversationId');
const route = '/chat/conversations/' + encodeURIComponent(id);
const records = await call(route + (raw.records === true ? '/records' : ''));
let data;
if (raw.toolCallId !== undefined) {
  const toolCallId = requiredString(raw.toolCallId, 'toolCallId');
  const toolCall = records.execution?.toolCalls.find((item) => item.id === toolCallId);
  if (!toolCall) throw new Error('Tool call not found in this conversation.');
  data = { conversation: records.conversation, toolCall };
} else {
  const execution = records.execution ? { ...records.execution, toolCalls: records.execution.toolCalls.map((item) => {
    if (item.status !== 'completed' || item.result?.type !== 'snapshot') return item;
    const { output, ...reference } = item;
    return { ...reference, outputReference: { tool: 'inspect_chat_conversation', input: { conversationId: id, toolCallId: item.id }, characters: output.length } };
  }) } : null;
  data = {
    conversation: records.conversation, execution,
    pendingReceipts: records.pendingReceipts,
    submissions: records.submissions.map(({ renderedCard, renderedTaskCards, ...item }) => item),
    ...(raw.records === true ? {
      events: records.events.filter((item) => item.data.kind === 'status'),
      receipts: records.receipts.map(({ payload, ...item }) => ({ ...item, text: payload.text, action: payload.action, direction: payload.direction })),
      receiptsTotal: records.receiptsTotal,
      deliveries: records.deliveries,
    } : {}),
    recordSelection: { events: 'status only; current messages and tool calls are above', submissions: 'without rendered cards', receipts: 'metadata, text and action only', snapshotToolOutputs: 'references; select toolCallId for full output', fullRecordsRoute: route + '/records' },
  };
}
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/start-chat-conversation.mjs', `#!/usr/bin/env node
import { backgroundOrigin, backgroundOriginNote, call, chatExecution, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['message']);
const message = requiredString(raw.message, 'message', 100000);
const parentId = requiredString(process.env.WORKLITE_CHAT_EXECUTION_ID, 'server conversation context', 240);
const parent = await chatExecution(parentId);
// One level only: a background conversation must not start further background conversations.
if (backgroundOrigin(parent)) throw new Error('This conversation was started by Chat in the background and cannot start another background conversation.');
const data = await call('/agents/agt_system_helper_chat/executions', { method: 'POST', body: { message: message + '\\n\\n' + backgroundOriginNote(parentId) } });
print({ worklite: { type: 'snapshot' }, data: { conversationId: data.id, status: data.status, route: '/chat?view=conversation&conversation=' + encodeURIComponent(data.id) } });
`],
  ['scripts/wait-chat-conversation.mjs', `#!/usr/bin/env node
import { chatExecution, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['conversationId', 'timeoutSeconds']);
const id = requiredString(raw.conversationId, 'conversationId', 240);
const timeoutSeconds = raw.timeoutSeconds === undefined ? 600 : raw.timeoutSeconds;
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 1800) throw new Error('timeoutSeconds must be an integer from 5 to 1800.');
const deadline = Date.now() + timeoutSeconds * 1000;
const toolCallName = (call) => call.mcpToolName ?? (call.scriptPath ? call.scriptPath.split('/').pop() : null) ?? call.skillName ?? 'tool';
const activeToolCall = (execution) => {
  const call = [...(execution.toolCalls ?? [])].reverse().find((item) => item.status === 'running');
  return call ? { id: call.id, name: toolCallName(call), startedAt: call.createdAt, elapsedSeconds: Math.max(0, Math.round((Date.now() - new Date(call.createdAt).getTime()) / 1000)) } : null;
};
const signature = (execution) => JSON.stringify({
  plan: (execution.plan ?? []).map((step) => step.status),
  latestMessageId: execution.messages?.length ? execution.messages[execution.messages.length - 1].id : null,
  activeToolCallId: activeToolCall(execution)?.id ?? null,
});
const snapshot = (execution, progressChanged) => ({
  conversationId: id, status: execution.status, settled: execution.status !== 'running', progressChanged,
  pendingQuestion: execution.pendingQuestion, error: execution.error, plan: execution.plan,
  activeToolCall: activeToolCall(execution),
  latestMessages: execution.messages.slice(-3),
});
let execution = await chatExecution(id);
let lastSignature = signature(execution);
while (execution.status === 'running' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, deadline - Date.now()))));
  execution = await chatExecution(id);
  const nextSignature = signature(execution);
  // Return as soon as the conversation visibly advances so the watcher can report what it is doing now.
  if (execution.status === 'running' && nextSignature !== lastSignature) {
    print({ worklite: { type: 'snapshot' }, data: snapshot(execution, true) });
    return;
  }
  lastSignature = nextSignature;
}
print({ worklite: { type: 'snapshot' }, data: snapshot(execution, false) });
`],
  ['scripts/message-chat-conversation.mjs', `#!/usr/bin/env node
import { backgroundOrigin, call, chatExecution, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['conversationId', 'message']);
const id = requiredString(raw.conversationId, 'conversationId', 240);
const message = requiredString(raw.message, 'message', 100000);
const parentId = requiredString(process.env.WORKLITE_CHAT_EXECUTION_ID, 'server conversation context', 240);
const execution = await chatExecution(id);
// Chat speaks only into conversations it started from this conversation; the user's own conversations stay theirs.
if (backgroundOrigin(execution) !== parentId) throw new Error('Only a background conversation started from this conversation can receive messages from Chat.');
if (execution.status === 'running') throw new Error('The background conversation is still running; wait_chat_conversation until it settles.');
const route = '/agents/agt_system_helper_chat/executions/' + encodeURIComponent(id);
const question = execution.status === 'waiting_for_input' ? execution.pendingQuestion : null;
if (question && (question.recovery || question.shellCallId)) throw new Error('This question settles an interrupted operation; the user must resolve it in the background conversation.');
const data = question
  ? await call(route + '/answers', { method: 'POST', body: { questionId: question.id, answer: message } })
  : await call(route + '/messages', { method: 'POST', body: { message } });
print({ worklite: { type: 'snapshot' }, data: { conversationId: id, delivered: question ? 'answer' : 'message', status: data.status } });
`],
  ['scripts/update-chat.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print } from './lib.mjs';
const body = input();
exactKeys(body, ['runtime', 'expectedConfigurationRevision', 'extensionPrompt', 'turnNotificationsEnabled', 'turnNotificationSound', 'providerId', 'model', 'skillIds']);
if (!Number.isSafeInteger(body.expectedConfigurationRevision) || body.expectedConfigurationRevision < 1) throw new Error('expectedConfigurationRevision is required and must be an integer of at least 1; inspect the current Chat configuration revision before updating.');
const data = await call('/agents/agt_system_helper_chat', { method: 'PATCH', body });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/propose-upgrade.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['summary']);
const executionId = process.env.WORKLITE_CHAT_EXECUTION_ID;
const submissionId = process.env.WORKLITE_CHAT_SUBMISSION_ID;
if (!executionId || !submissionId) throw new Error('Upgrade proposals require a server-bound Chat turn.');
const data = await call('/upgrades', { method: 'POST', body: { summary: requiredString(raw.summary, 'summary', 100000), executionId, submissionId } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/redeploy.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['summary']);
const executionId = process.env.WORKLITE_CHAT_EXECUTION_ID;
const submissionId = process.env.WORKLITE_CHAT_SUBMISSION_ID;
const userMessageId = process.env.WORKLITE_CHAT_USER_MESSAGE_ID;
if (!executionId || !submissionId || !userMessageId) throw new Error('Redeployment requires a server-bound Chat user request.');
const data = await call('/upgrades/redeploy', { method: 'POST', body: { summary: requiredString(raw.summary, 'summary', 100000), executionId, submissionId, userMessageId } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-upgrade.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['jobId']);
const data = await call('/upgrades/' + encodeURIComponent(requiredString(raw.jobId, 'jobId', 240)));
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-workspace.mjs', `#!/usr/bin/env node
import { call, noInput, print } from './lib.mjs';
noInput();
// Snapshot includes credential-safe Feishu setup capabilities; application registration belongs to its Web configuration page.
const data = await call('/platform/snapshot');
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-workflow.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';

// Keep this result below the 60000-character Chat script-output limit and mark every omission.
const MAX_OUTPUT_CHARS = 50000;
const RESERVE_CHARS = 2500;
const raw = input();
exactKeys(raw, ['workflowId', 'name', 'includeDraft', 'versions', 'runLimit']);
const workflowId = raw.workflowId === undefined ? undefined : requiredString(raw.workflowId, 'workflowId', 240);
const name = raw.name === undefined ? undefined : requiredString(raw.name, 'name', 120);
if (!workflowId && !name) throw new Error('Provide workflowId, or name when exactly one Workflow has that name.');
if (workflowId && name) throw new Error('Provide either workflowId or name, not both.');
if (raw.includeDraft !== undefined && typeof raw.includeDraft !== 'boolean') throw new Error('includeDraft must be a boolean.');
const includeDraft = raw.includeDraft !== false;
const versionsMode = raw.versions === undefined ? 'latest' : oneOf(raw.versions, 'versions', ['latest', 'all', 'none']);
const runLimit = raw.runLimit === undefined ? 5 : raw.runLimit;
if (!Number.isInteger(runLimit) || runLimit < 0 || runLimit > 20) throw new Error('runLimit must be an integer from 0 to 20.');

let resolvedId = workflowId;
if (!resolvedId) {
  const workflows = await call('/workflows');
  const matches = workflows.filter((workflow) => workflow.name === name);
  if (matches.length === 0) throw new Error('Workflow not found by name.');
  if (matches.length > 1) throw new Error('Multiple Workflows share this name; pass workflowId.');
  resolvedId = matches[0].id;
}

const [detail, versionRows, schedule, runRows] = await Promise.all([
  call('/workflows/' + encodeURIComponent(resolvedId)),
  call('/workflows/' + encodeURIComponent(resolvedId) + '/versions'),
  call('/workflows/' + encodeURIComponent(resolvedId) + '/schedule').catch(() => null),
  runLimit === 0 ? [] : call('/runs?workflowId=' + encodeURIComponent(resolvedId) + '&limit=' + runLimit),
]);

// Edge fields follow the stored shape; expose source/target names used by edit_workflow plans.
const graphOf = (definition) => ({
  nodes: (Array.isArray(definition.nodes) ? definition.nodes : []).map((node) => ({ id: node.id, type: node.type, typeVersion: node.typeVersion, config: node.config, position: node.position, errorPolicy: node.errorPolicy })),
  edges: (Array.isArray(definition.edges) ? definition.edges : []).map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, sourcePort: edge.sourcePort, targetPort: edge.targetPort, ...(edge.condition === undefined ? {} : { condition: edge.condition }), ...(edge.maxTraversals === undefined ? {} : { maxTraversals: edge.maxTraversals }) })),
});
const versions = Array.isArray(versionRows) ? versionRows : [];
const draftDefinition = detail.draft && detail.draft.definition ? detail.draft.definition : null;
const draftGraph = includeDraft && draftDefinition ? graphOf(draftDefinition) : null;
const result = {
  workflow: {
    id: detail.id, name: detail.name, state: detail.state, stepCount: detail.stepCount,
    latestVersionId: detail.latestVersionId, latestVersion: detail.latestVersion,
    lastRunStatus: detail.lastRunStatus, lastRunAt: detail.lastRunAt, updatedAt: detail.updatedAt,
    dashboard: detail.dashboard === undefined ? null : detail.dashboard,
    schedule: schedule === undefined ? null : schedule,
  },
  draft: detail.draft ? {
    id: detail.draft.id, revisionId: detail.draft.revisionId, updatedAt: detail.draft.updatedAt,
    canUndo: detail.draft.canUndo, canRedo: detail.draft.canRedo,
    defaults: draftDefinition ? draftDefinition.defaults : null,
    input: draftDefinition ? draftDefinition.input : null,
    graph: draftGraph ? { nodeCount: draftGraph.nodes.length, edgeCount: draftGraph.edges.length, nodes: [], edges: [] } : null,
  } : null,
  publishedVersions: versions.map((version) => ({
    id: version.id, version: version.version, publishedAt: version.publishedAt, publishedBy: version.publishedBy,
    sourceRevisionId: version.sourceRevisionId, schemaVersion: version.schemaVersion,
    nodeCount: version.definition && Array.isArray(version.definition.nodes) ? version.definition.nodes.length : null,
    edgeCount: version.definition && Array.isArray(version.definition.edges) ? version.definition.edges.length : null,
    definition: null,
  })),
  recentRuns: [],
  truncation: null,
};

let truncated = false;
const omitted = { versionDefinitions: [], versionMetadata: [], recentRuns: 0, draftNodeIds: [], draftEdgeIds: [], draftInput: false };
const characters = () => JSON.stringify(result).length;
const fits = () => characters() + RESERVE_CHARS <= MAX_OUTPUT_CHARS;

if (draftGraph && result.draft && result.draft.graph) {
  for (const node of draftGraph.nodes) {
    result.draft.graph.nodes.push(node);
    if (!fits()) {
      result.draft.graph.nodes.pop();
      omitted.draftNodeIds.push(node.id);
      truncated = true;
    }
  }
  const keptNodeIds = new Set(result.draft.graph.nodes.map((node) => node.id));
  for (const edge of draftGraph.edges) {
    if (!keptNodeIds.has(edge.source) || !keptNodeIds.has(edge.target)) {
      omitted.draftEdgeIds.push(edge.id);
      truncated = true;
      continue;
    }
    result.draft.graph.edges.push(edge);
    if (!fits()) {
      result.draft.graph.edges.pop();
      omitted.draftEdgeIds.push(edge.id);
      truncated = true;
    }
  }
}

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const runs = (Array.isArray(runRows) ? runRows : []).filter((run) => run.workflowId === resolvedId).slice(0, runLimit);
for (const run of runs) {
  const startedAt = new Date(run.startedAt).getTime();
  const finishedAt = terminal.has(run.status) && Number.isFinite(startedAt) && typeof run.durationSeconds === 'number'
    ? new Date(startedAt + run.durationSeconds * 1000).toISOString()
    : null;
  result.recentRuns.push({
    runId: run.id, status: run.status, startedAt: run.startedAt, finishedAt,
    durationSeconds: typeof run.durationSeconds === 'number' ? run.durationSeconds : null,
    version: run.version === undefined ? null : run.version,
    currentStep: run.currentStep === undefined ? null : run.currentStep,
  });
  if (!fits()) {
    result.recentRuns.pop();
    omitted.recentRuns += 1;
    truncated = true;
  }
}

const rowsById = new Map(versions.map((version) => [version.id, version]));
const wantedVersionIds = versionsMode === 'none' ? [] : versionsMode === 'all' ? result.publishedVersions.map((version) => version.id) : result.publishedVersions.slice(0, 1).map((version) => version.id);
for (const version of result.publishedVersions) {
  if (!wantedVersionIds.includes(version.id)) continue;
  const row = rowsById.get(version.id);
  if (!row || !row.definition) continue;
  version.definition = { defaults: row.definition.defaults === undefined ? null : row.definition.defaults, input: row.definition.input === undefined ? null : row.definition.input, ...graphOf(row.definition) };
  if (!fits()) {
    version.definition = null;
    omitted.versionDefinitions.push(version.version);
    truncated = true;
  }
}

// Last-resort reductions keep the metadata response inside the hard limit and record each loss.
if (!fits()) {
  truncated = true;
  if (draftGraph && result.draft && result.draft.graph) {
    result.draft.graph = null;
    omitted.draftNodeIds = draftGraph.nodes.map((node) => node.id);
    omitted.draftEdgeIds = draftGraph.edges.map((edge) => edge.id);
  }
}
while (!fits() && result.publishedVersions.length > 1) {
  const dropped = result.publishedVersions.pop();
  omitted.versionMetadata.push(dropped.version);
  truncated = true;
}
if (!fits() && result.draft && result.draft.input !== null) {
  result.draft.input = null;
  omitted.draftInput = true;
  truncated = true;
}
if (!fits()) {
  omitted.recentRuns += result.recentRuns.length;
  result.recentRuns = [];
  truncated = true;
}

if (truncated) {
  result.truncation = {
    limited: true,
    maxCharacters: MAX_OUTPUT_CHARS,
    omittedVersionDefinitions: omitted.versionDefinitions,
    omittedVersionMetadata: omitted.versionMetadata,
    omittedRecentRuns: omitted.recentRuns,
    omittedDraftNodeIds: omitted.draftNodeIds,
    omittedDraftEdgeIds: omitted.draftEdgeIds,
    omittedDraftInput: omitted.draftInput,
    note: 'The response exceeded the size limit and every omitted item is listed here. Read one published version with query_platform GET /workflow-versions/<versionId>, a single Run with inspect_workflow_run, or the raw Workflow with query_platform GET /workflows/<workflowId>.',
  };
}

if (characters() > MAX_OUTPUT_CHARS) {
  print({ worklite: { type: 'snapshot' }, data: {
    workflow: { id: detail.id, name: detail.name, state: detail.state },
    draft: null,
    publishedVersions: [],
    recentRuns: [],
    truncation: {
      limited: true,
      maxCharacters: MAX_OUTPUT_CHARS,
      omittedVersionDefinitions: omitted.versionDefinitions,
      omittedVersionMetadata: omitted.versionMetadata,
      omittedRecentRuns: omitted.recentRuns,
      omittedDraftNodeIds: omitted.draftNodeIds,
      omittedDraftEdgeIds: omitted.draftEdgeIds,
      omittedDraftInput: omitted.draftInput,
      note: 'The Workflow metadata exceeded the size limit; read it in parts with query_platform.',
    },
  } });
} else {
  print({ worklite: { type: 'snapshot' }, data: result });
}
`],
  ['scripts/query-platform.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';

// Keep this result below the 60000-character Chat script-output limit and mark every omission.
const MAX_OUTPUT_CHARS = 50000;
const RESERVE_CHARS = 3000;
const BACKSLASH = String.fromCharCode(92);
const READ_PREFIXES = ['/agents', '/agent-actions', '/artifacts', '/skills', '/mcp-servers', '/portkey-gateway', '/chat/conversations', '/chat/project-tasks', '/chat/memories', '/chat/channels', '/usage', '/audit-logs', '/api-request-logs', '/platform/snapshot', '/settings', '/local-projects'];
const SENSITIVE_KEYS = new Set(['apikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'secret', 'clientsecret', 'password', 'passwd', 'credential', 'credentials', 'authorization', 'privatekey', 'accesskey', 'sessionkey', 'bearer', 'cookie', 'encryptedstorage', 'storagestate', 'encryptedkey', 'encryptionkey']);

const raw = input();
exactKeys(raw, ['method', 'path', 'query', 'cursor']);
if (raw.method !== undefined && raw.method !== 'GET') throw new Error('Only GET is allowed.');
const path = requiredString(raw.path, 'path', 2000);
const cursor = raw.cursor === undefined ? undefined : requiredString(raw.cursor, 'cursor', 2000);

function reject(message) {
  throw new Error(message + ' query_platform accepts one site-relative GET under a supported read-only prefix; pass query parameters through query.');
}
if (path.charAt(0) !== '/') reject('path must begin with /.');
if (path.length < 2) reject('path must name a resource.');
if (path.charAt(1) === '/') reject('Protocol-relative paths are not allowed.');
if (path.charAt(path.length - 1) === '/') reject('path must not end with /.');
if (path.indexOf('?') !== -1) reject('Put query parameters in query, not in path.');
if (path.indexOf('#') !== -1) reject('Fragments are not allowed.');
if (path.indexOf(':') !== -1) reject('Absolute URLs and protocols are not allowed.');
if (path.indexOf(BACKSLASH) !== -1) reject('Backslashes are not allowed.');
if (path.indexOf('//') !== -1) reject('Empty path segments are not allowed.');
for (let index = 0; index < path.length; index += 1) {
  const code = path.charCodeAt(index);
  if (code < 32 || code === 127 || code === 32) reject('Control characters and spaces are not allowed; percent-encode them.');
}
for (const segment of path.slice(1).split('/')) {
  if (!segment) reject('Empty path segments are not allowed.');
  let decoded;
  try { decoded = decodeURIComponent(segment); } catch { reject('Malformed percent-encoding in path.'); }
  if (decoded === '.' || decoded === '..') reject('Path traversal is not allowed.');
  if (decoded.indexOf('/') !== -1 || decoded.indexOf(BACKSLASH) !== -1) reject('Encoded path separators are not allowed.');
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (code < 32 || code === 127) reject('Control characters are not allowed.');
  }
}
const allowed = READ_PREFIXES.some((prefix) => path === prefix || path.indexOf(prefix + '/') === 0);
if (!allowed) reject('path is outside the supported read-only prefixes.');
if (path.slice(-7) === '/events') reject('Event streams are not supported; read the settled Run with inspect_workflow_run.');

function normalizeQuery(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('query must be a flat object of string, number or boolean values.');
  const keys = Object.keys(value);
  if (keys.length > 30) throw new Error('query may contain at most 30 parameters.');
  const normalized = {};
  for (const key of keys) {
    if (!key || key.length > 120) throw new Error('Every query key must be a non-empty string no longer than 120 characters.');
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Unsupported query key: ' + key + '.');
    for (let index = 0; index < key.length; index += 1) {
      const code = key.charCodeAt(index);
      if (code < 32 || code === 127) throw new Error('Query keys must not contain control characters.');
    }
    const item = value[key];
    if (item === undefined || item === null) continue;
    const type = typeof item;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') throw new Error('Query value for ' + key + ' must be a string, number or boolean.');
    if (type === 'number' && !Number.isFinite(item)) throw new Error('Query number for ' + key + ' must be finite.');
    if (type === 'string' && item.length > 2000) throw new Error('Query string for ' + key + ' must be no longer than 2000 characters.');
    normalized[key] = item;
  }
  return normalized;
}
const query = normalizeQuery(raw.query);
if (cursor !== undefined) query.cursor = cursor;
const params = new URLSearchParams();
for (const [key, value] of Object.entries(query)) params.set(key, String(value));
const requestPath = path + (params.size > 0 ? '?' + params.toString() : '');
// Internal API only: never follow a redirect out of the WorkLite host.
const body = await call(requestPath, { redirect: 'error' });

const redactedFields = [];
function sensitiveKey(key) {
  const normalized = key.toLowerCase().replaceAll('-', '').replaceAll('_', '').replaceAll(' ', '');
  if (normalized === 'maskedkey' || normalized === 'maskedapikey' || normalized === 'hasapikey' || normalized === 'apikeyset') return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  // Only suffix matches for short words so usage counters such as tokenCount stay readable.
  if (normalized.includes('secret') || normalized.includes('password') || normalized.includes('credential')) return true;
  return normalized.endsWith('apikey') || normalized.endsWith('accesskey') || normalized.endsWith('privatekey') || normalized.endsWith('token');
}
function redact(value, trail) {
  if (Array.isArray(value)) return value.map((item, index) => redact(item, trail + '[' + index + ']'));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const keyPath = trail ? trail + '.' + key : key;
    if (sensitiveKey(key) && typeof item !== 'boolean' && item !== null) {
      if (typeof item === 'string' && item.length === 0) { output[key] = item; continue; }
      output[key] = '[redacted]';
      if (redactedFields.length < 50 && !redactedFields.includes(keyPath)) redactedFields.push(keyPath);
      continue;
    }
    output[key] = redact(item, keyPath);
  }
  return output;
}
const redacted = redact(body, '');
const serialized = JSON.stringify(redacted);
const meta = { method: 'GET', path, query, redactedFields };
if (JSON.stringify(meta).length + serialized.length + RESERVE_CHARS <= MAX_OUTPUT_CHARS) {
  print({ worklite: { type: 'snapshot' }, data: { ...meta, truncated: false, body: redacted } });
} else {
  const note = 'The response body exceeded the size limit; narrow the request with filters, limit or cursor. bodyPreview is a character prefix and may cut JSON mid-structure.';
  const probe = { ...meta, truncated: true, bodyCharacters: serialized.length, maxCharacters: MAX_OUTPUT_CHARS, bodyPreview: '', note };
  const available = Math.max(0, MAX_OUTPUT_CHARS - RESERVE_CHARS - JSON.stringify(probe).length);
  print({ worklite: { type: 'snapshot' }, data: { ...probe, bodyPreview: serialized.slice(0, available) } });
}
`],
  ['scripts/inspect-agent-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, stringValue } from './lib.mjs';
const raw = input(); exactKeys(raw, ['runId']);
const runId = stringValue(raw.runId, 'runId');
if (!runId) throw new Error('runId is required.');
const data = await call('/agents/run-usage/' + encodeURIComponent(runId));
const usage = (run) => ({ runId: run.id, executionId: run.executionId, agentId: run.agentId, agentName: run.agentName, parentRunId: run.parentRunId, status: run.status, runtime: run.runtime, usage: run.usage, commandExecutionId: run.commandExecutionId });
print({ worklite: { type: 'snapshot' }, data: { run: usage(data.run), invocations: data.invocations.map(usage), gatewayUsage: data.gatewayUsage } });
`],
  ['scripts/inspect-gateway-stats.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, stringValue } from './lib.mjs';
const ATTRIBUTION = ['surface', 'conversationId', 'agentRunId', 'agentExecutionId', 'projectTaskId', 'executor', 'coderId', 'teamRunId', 'workflowId', 'workflowRunId', 'nodeRunId'];
const raw = input(); exactKeys(raw, ['from', 'to', 'groupBy', ...ATTRIBUTION]);
const query = new URLSearchParams();
for (const key of ['from', 'to']) {
  const value = stringValue(raw[key], key);
  if (!value) throw new Error(key + ' must be an absolute ISO-8601 instant.');
  query.set(key, value);
}
for (const key of ['groupBy', ...ATTRIBUTION]) {
  if (raw[key] !== undefined) query.set(key, stringValue(raw[key], key));
}
const data = await call('/portkey-gateway/stats?' + query.toString());
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-gateway-request-logs.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, stringValue } from './lib.mjs';
const ATTRIBUTION = ['surface', 'conversationId', 'agentRunId', 'agentExecutionId', 'projectTaskId', 'executor', 'coderId', 'teamRunId', 'workflowId', 'workflowRunId', 'nodeRunId'];
const raw = input(); exactKeys(raw, ['from', 'to', 'provider', 'model', 'statusClass', ...ATTRIBUTION, 'limit', 'cursor']);
const query = new URLSearchParams();
for (const key of ['from', 'to']) {
  const value = stringValue(raw[key], key);
  if (!value) throw new Error(key + ' must be an absolute ISO-8601 instant.');
  query.set(key, value);
}
for (const key of ['provider', 'model', 'statusClass', ...ATTRIBUTION, 'cursor']) {
  if (raw[key] !== undefined) query.set(key, stringValue(raw[key], key));
}
if (raw.limit !== undefined) query.set('limit', String(raw.limit));
const data = await call('/portkey-gateway/request-logs?' + query.toString());
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-gateway-request-log.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, stringValue } from './lib.mjs';
const raw = input(); exactKeys(raw, ['requestLogId']);
const id = stringValue(raw.requestLogId, 'requestLogId');
if (!id) throw new Error('requestLogId is required.');
const data = await call('/portkey-gateway/request-logs/' + encodeURIComponent(id));
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/discover-provider-models.mjs', [
    '#!/usr/bin/env node',
    "import { call, exactKeys, input, print, requiredString } from './lib.mjs';",
    "const raw = input(); exactKeys(raw, ['providerId']);",
    "const providerId = requiredString(raw.providerId, 'providerId', 240);",
    "const result = await call('/portkey-gateway/providers/' + encodeURIComponent(providerId) + '/discover-models', { method: 'POST' });",
    "if (!Array.isArray(result?.models) || result.models.some((model) => typeof model !== 'string' || !model.trim())) throw Object.assign(new Error('Invalid models response.'), { workliteCode: 'PLATFORM_API_RESPONSE_INVALID' });",
    "const models = result.models;",
    "print({ worklite: { type: 'provider_models', providerId }, data: { models } });",
  ].join('\n') + '\n'],
  ['scripts/update-provider-models.mjs', [
    '#!/usr/bin/env node',
    "import { call, exactKeys, input, print, requiredString, stringArray } from './lib.mjs';",
    "const raw = input(); exactKeys(raw, ['providerId', 'addModels']);",
    "const providerId = requiredString(raw.providerId, 'providerId', 240);",
    "const addModels = stringArray(raw.addModels, 'addModels', 100, 240);",
    "const result = await call('/portkey-gateway/providers/' + encodeURIComponent(providerId) + '/models', { method: 'PATCH', body: { addModels } });",
    "if (!Array.isArray(result?.models) || result.models.some((model) => typeof model !== 'string' || !model.trim()) || result.providerId !== providerId) throw Object.assign(new Error('Invalid provider models response.'), { workliteCode: 'PLATFORM_API_RESPONSE_INVALID' });",
    "const models = result.models;",
    "const resultProviderId = result.providerId;",
    "print({ worklite: { type: 'provider_models', providerId: resultProviderId }, data: { providerId: resultProviderId, models } });",
  ].join('\n') + '\n'],
  ['scripts/create-provider.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, optionalString, print, requiredString, stringArray } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'protocol', 'baseURL', 'models']);
const body = { name: requiredString(raw.name, 'name', 120), protocol: oneOf(raw.protocol, 'protocol', ['openai/chat', 'openai/responses', 'anthropic/messages', 'codex/responses', 'typesafe/systemone']), baseURL: requiredString(raw.baseURL, 'baseURL', 2048), models: stringArray(raw.models, 'models', 100, 200) };
for (const [field, maxLength] of [['baseURL', 2048]]) {
  const value = optionalString(raw[field], field, maxLength);
  if (value !== undefined) body[field] = value;
}
const resource = await call('/portkey-gateway/providers', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'provider', id: resource.id, route: '/model-providers' }, data: resource });
`],
  ['scripts/create-skill.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, packageFiles, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'files']);
const body = { name: requiredString(raw.name, 'name', 120), files: packageFiles(raw.files) };
const resource = await call('/skills', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'skill', id: resource.id, route: '/skills/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/create-mcp-server.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'endpoint']);
const body = { name: requiredString(raw.name, 'name', 120), endpoint: boundedString(raw.endpoint, 'endpoint', 2048) };
const resource = await call('/mcp-servers', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'mcp-server', id: resource.id, route: '/mcp-servers/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/delete-mcp-server.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['mcpServerId', 'confirm', 'force']);
const mcpServerId = requiredString(raw.mcpServerId, 'mcpServerId', 240);
if (raw.confirm !== true) throw new Error('confirm must be true after the user explicitly confirms permanent MCP server deletion.');
if (raw.force !== undefined && typeof raw.force !== 'boolean') throw new Error('force must be a boolean when provided.');
const force = raw.force === true;
const data = await call('/mcp-servers/' + encodeURIComponent(mcpServerId) + (force ? '?force=true' : ''), { method: 'DELETE' });
print({ worklite: { type: 'snapshot' }, data: data ?? { deleted: mcpServerId, force } });
`],
  ['scripts/create-workflow.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name']);
const resource = await call('/workflows', { method: 'POST', body: { name: requiredString(raw.name, 'name', 120) } });
print({ worklite: { type: 'resource', resourceType: 'workflow', id: resource.id, route: '/workflows/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/edit-workflow.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString } from './lib.mjs';
// Workflow plans may use worklite/branch for JSON conditional routing, typesafe/systemone for typed state/question calls, and typesafe/systemone-map for per-element evaluation over an array; edge conditions are normalized by the API.
const raw = input();
exactKeys(raw, ['workflowId', 'sourceInstruction', 'plan']);
const workflowId = requiredString(raw.workflowId, 'workflowId', 240);
const sourceInstruction = boundedString(raw.sourceInstruction, 'sourceInstruction', 4000);
if (!raw.plan || typeof raw.plan !== 'object' || Array.isArray(raw.plan)) throw new Error('plan must be an object.');
const current = await call('/workflows/' + encodeURIComponent(workflowId));
if (!current.draft || typeof current.draft.revisionId !== 'string') throw new Error('The Workflow draft revision is unavailable.');
const resource = await call('/workflows/' + encodeURIComponent(workflowId) + '/draft/operations', { method: 'POST', body: { baseRevisionId: current.draft.revisionId, plan: raw.plan, source: 'assistant', sourceInstruction } });
print({ worklite: { type: 'resource', resourceType: 'workflow', id: resource.id, route: '/workflows/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/patch-workflow.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString } from './lib.mjs';
// The API translates the patch into fine-grained draft operations, so untouched nodes and edges keep their ids and positions.
const raw = input();
exactKeys(raw, ['workflowId', 'baseRevisionId', 'sourceInstruction', 'patch']);
const workflowId = requiredString(raw.workflowId, 'workflowId', 240);
const sourceInstruction = boundedString(raw.sourceInstruction, 'sourceInstruction', 4000);
if (!Array.isArray(raw.patch) || raw.patch.length === 0) throw new Error('patch must be a non-empty array of patch entries.');
let baseRevisionId = raw.baseRevisionId === undefined ? undefined : requiredString(raw.baseRevisionId, 'baseRevisionId', 240);
if (baseRevisionId === undefined) {
  const current = await call('/workflows/' + encodeURIComponent(workflowId));
  if (!current.draft || typeof current.draft.revisionId !== 'string') throw new Error('The Workflow draft revision is unavailable.');
  baseRevisionId = current.draft.revisionId;
}
const resource = await call('/workflows/' + encodeURIComponent(workflowId) + '/draft/operations', { method: 'POST', body: { baseRevisionId, patch: raw.patch, source: 'assistant', sourceInstruction } });
print({ worklite: { type: 'resource', resourceType: 'workflow', id: resource.id, route: '/workflows/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/replace-workflow-agent-models.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString, stringArray } from './lib.mjs';
const raw = input();
exactKeys(raw, ['workflowId', 'fromModel', 'toModel', 'nodeIds', 'sourceInstruction']);
const workflowId = requiredString(raw.workflowId, 'workflowId', 240);
const fromModel = requiredString(raw.fromModel, 'fromModel', 240);
const toModel = requiredString(raw.toModel, 'toModel', 240);
const nodeIds = raw.nodeIds === undefined ? undefined : stringArray(raw.nodeIds, 'nodeIds', 1000, 240);
const sourceInstruction = raw.sourceInstruction === undefined ? 'Replace ' + fromModel + ' with ' + toModel + ' on Workflow Agent nodes.' : boundedString(raw.sourceInstruction, 'sourceInstruction', 4000);
const current = await call('/workflows/' + encodeURIComponent(workflowId));
if (!current.draft || typeof current.draft.revisionId !== 'string') throw new Error('The Workflow draft revision is unavailable.');
const body = { baseRevisionId: current.draft.revisionId, fromModel, toModel, source: 'assistant', sourceInstruction, ...(nodeIds === undefined ? {} : { nodeIds }) };
const resource = await call('/workflows/' + encodeURIComponent(workflowId) + '/draft/model-replacement', { method: 'POST', body });
print({ worklite: { type: 'resource', resourceType: 'workflow', id: resource.id, route: '/workflows/' + encodeURIComponent(resource.id) }, data: resource });
`],
  ['scripts/publish-workflow.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['workflowId']);
const workflowId = requiredString(raw.workflowId, 'workflowId', 240);
const current = await call('/workflows/' + encodeURIComponent(workflowId));
if (!current.draft || typeof current.draft.revisionId !== 'string') throw new Error('The Workflow draft revision is unavailable.');
const data = await call('/workflows/' + encodeURIComponent(workflowId) + '/publish', { method: 'POST' });
print({ worklite: { type: 'resource', resourceType: 'workflow', id: current.id, route: '/workflows/' + encodeURIComponent(current.id) }, data });
`],
  ['scripts/delete-workflow.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['workflowId', 'confirm', 'force']);
const workflowId = requiredString(raw.workflowId, 'workflowId', 240);
if (raw.confirm !== true) throw new Error('confirm must be true after the user explicitly confirms permanent Workflow deletion.');
if (raw.force !== undefined && typeof raw.force !== 'boolean') throw new Error('force must be a boolean when provided.');
const force = raw.force === true;
await call('/workflows/' + encodeURIComponent(workflowId) + (force ? '?force=true' : ''), { method: 'DELETE' });
print({ worklite: { type: 'snapshot' }, data: { deleted: workflowId, force } });
`],
  ['scripts/dispatch-task.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString, text } from './lib.mjs';
const raw = input(); exactKeys(raw, ['message', 'target']);
const target = raw.target;
if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('A Coder target is required.');
exactKeys(target, ['kind', 'coderId', 'projectDirectory', 'role']);
const normalized = { kind: oneOf(target.kind, 'target.kind', ['coder']), coderId: requiredString(target.coderId, 'coderId', 240), projectDirectory: requiredString(target.projectDirectory, 'projectDirectory', 2000), ...(target.role === undefined ? {} : { role: requiredString(target.role, 'role', 240) }) };
const executionId = requiredString(process.env.WORKLITE_CHAT_EXECUTION_ID, 'server conversation context', 240);
const submissionId = requiredString(process.env.WORKLITE_CHAT_SUBMISSION_ID, 'server submission context', 240);
const data = await call('/chat/dispatch', { method: 'POST', body: { submissionId, executionId, message: text(raw.message, 'message', 100000), target: normalized } });
print({ worklite: { type: 'dispatch', submissionId: data.submissionId, route: '/coding/runs/' + encodeURIComponent(data.reference.runId) }, data });
`],
  ['scripts/inspect-workflow-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId']);
const runId = requiredString(raw.runId, 'runId', 240);
const data = await call('/runs/' + encodeURIComponent(runId));
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/refresh-workflow-run-pending-action.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId']);
const runId = requiredString(raw.runId, 'runId', 240);
const data = await call('/runs/' + encodeURIComponent(runId) + '/pending-action/refresh', { method: 'POST', body: {} });
const action = data && typeof data === 'object' ? data.pendingAction : null;
const expiresAt = action && typeof action.expiresAt === 'string' ? Date.parse(action.expiresAt) : Number.NaN;
if (!action || action.status !== 'pending' || typeof action.qrCode !== 'string' || !action.qrCode.startsWith('data:image/png;base64,') || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
  throw new Error('The Workflow Run did not return a current scannable QR code.');
}
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-wechat-draft.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'draftId', 'verify']);
if (raw.verify !== undefined && typeof raw.verify !== 'boolean') throw new Error('verify must be a boolean.');
const base = '/runs/' + encodeURIComponent(requiredString(raw.runId, 'runId', 240)) + '/wechat-drafts/' + encodeURIComponent(requiredString(raw.draftId, 'draftId', 40));
const data = await call(base);
if (raw.verify === true) data.liveCheck = await call(base + '/verify', { method: 'POST', body: {} });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/render-article-image.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'draftId', 'key', 'html', 'width', 'height']);
const base = '/runs/' + encodeURIComponent(requiredString(raw.runId, 'runId', 240)) + '/wechat-drafts/' + encodeURIComponent(requiredString(raw.draftId, 'draftId', 40));
if (typeof raw.html !== 'string' || !raw.html.trim()) throw new Error('html is required.');
for (const field of ['width', 'height']) if (raw[field] !== undefined && !Number.isInteger(raw[field])) throw new Error(field + ' must be an integer.');
const data = await call(base + '/images', { method: 'POST', body: { key: requiredString(raw.key, 'key', 64), html: raw.html, ...(raw.width === undefined ? {} : { width: raw.width }), ...(raw.height === undefined ? {} : { height: raw.height }) } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/revise-wechat-draft.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'draftId', 'requestKey', 'title', 'imageReplacements']);
const base = '/runs/' + encodeURIComponent(requiredString(raw.runId, 'runId', 240)) + '/wechat-drafts/' + encodeURIComponent(requiredString(raw.draftId, 'draftId', 40));
if (raw.title !== undefined && typeof raw.title !== 'string') throw new Error('title must be a string.');
if (raw.imageReplacements !== undefined && (!raw.imageReplacements || typeof raw.imageReplacements !== 'object' || Array.isArray(raw.imageReplacements))) throw new Error('imageReplacements must be an object.');
let revision = await call(base + '/revisions', { method: 'POST', body: { requestKey: requiredString(raw.requestKey, 'requestKey', 120), ...(raw.title === undefined ? {} : { title: raw.title }), ...(raw.imageReplacements === undefined ? {} : { imageReplacements: raw.imageReplacements }) } });
const deadline = Date.now() + 300000;
while (revision.status === 'applying' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  revision = await call(base + '/revisions/' + encodeURIComponent(revision.id));
}
const note = revision.status === 'applying' ? 'Still applying; read it again later with inspect_wechat_draft. Do not submit a new requestKey.' : revision.status === 'uncertain' ? 'Save was clicked but the result is unknown. Do not retry with a new requestKey; ask the user to check the draft in the WeChat backend, then call resolve_wechat_draft_revision.' : undefined;
print({ worklite: { type: 'snapshot' }, data: note ? { ...revision, note } : revision });
`],
  ['scripts/resolve-wechat-draft-revision.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'draftId', 'revisionId', 'outcome', 'note']);
const base = '/runs/' + encodeURIComponent(requiredString(raw.runId, 'runId', 240)) + '/wechat-drafts/' + encodeURIComponent(requiredString(raw.draftId, 'draftId', 40));
const data = await call(base + '/revisions/' + encodeURIComponent(requiredString(raw.revisionId, 'revisionId', 120)) + '/resolve', { method: 'POST', body: { outcome: oneOf(raw.outcome, 'outcome', ['saved', 'not_saved']), note: requiredString(raw.note, 'note', 1000) } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/control-workflow-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'action', 'nodeRunId']);
const runId = requiredString(raw.runId, 'runId', 240);
const action = oneOf(raw.action, 'action', ['pause', 'resume', 'cancel', 'retry']);
const path = action === 'retry' ? '/runs/' + encodeURIComponent(runId) + '/nodes/' + encodeURIComponent(requiredString(raw.nodeRunId, 'nodeRunId', 240)) + '/retry' : '/runs/' + encodeURIComponent(runId) + '/' + action;
const data = await call(path, { method: 'POST', body: {} });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/inspect-coders.mjs', `#!/usr/bin/env node
import { call, noInput, print } from './lib.mjs';
noInput();
const data = await call('/coders');
print({ worklite: { type: 'coders' }, data });
`],
  ['scripts/create-coder.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'description', 'templateCoderId']);
const body = { name: requiredString(raw.name, 'name', 64) };
if (raw.description !== undefined) body.description = boundedString(raw.description, 'description', 100000);
if (raw.templateCoderId !== undefined) body.templateCoderId = requiredString(raw.templateCoderId, 'templateCoderId', 240);
const data = await call('/coders', { method: 'POST', body });
print({ worklite: { type: 'coder', id: data.id }, data });
`],
  ['scripts/inspect-coder.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId));
print({ worklite: { type: 'coder', id: data.id }, data });
`],
  ['scripts/update-coder.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'name', 'description', 'expectedRevision', 'workingPractice', 'projectGitPolicy', 'maxConcurrentRuns']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const body = {};
if (raw.name !== undefined) body.name = requiredString(raw.name, 'name', 64);
if (raw.description !== undefined) body.description = boundedString(raw.description, 'description', 100000);
if (raw.expectedRevision !== undefined) {
  if (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 0) throw new Error('expectedRevision must be the non-negative integer revision from inspect_coder.');
  body.expectedRevision = raw.expectedRevision;
}
if (raw.workingPractice !== undefined) body.workingPractice = boundedString(raw.workingPractice, 'workingPractice', 100000);
if (raw.projectGitPolicy !== undefined) body.projectGitPolicy = boundedString(raw.projectGitPolicy, 'projectGitPolicy', 100000);
if (raw.maxConcurrentRuns !== undefined) {
  if (!Number.isInteger(raw.maxConcurrentRuns) || raw.maxConcurrentRuns < 1) throw new Error('maxConcurrentRuns must be an integer of at least 1.');
  body.maxConcurrentRuns = raw.maxConcurrentRuns;
}
if (!Object.keys(body).some((key) => key !== 'expectedRevision')) throw new Error('Provide name, description, workingPractice, projectGitPolicy or maxConcurrentRuns.');
const data = await call('/coders/' + encodeURIComponent(coderId), { method: 'PATCH', body });
print({ worklite: { type: 'coder', id: data.id }, data });
`],
  ['scripts/delete-coder.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'confirm']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
if (raw.confirm !== true) throw new Error('confirm must be true after the user explicitly confirms deleting this Coder.');
const data = await call('/coders/' + encodeURIComponent(coderId), { method: 'DELETE', body: { confirmTeamId: coderId } });
print({ worklite: { type: 'coder', id: coderId }, data });
`],
  ['scripts/create-coder-role.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, modelSelection, oneOf, print, requiredString, stringArray } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'displayName', 'publicModelId', 'instructions', 'entryPoints', 'skillIds', 'mcpServerIds', 'toolNames', 'executor']);
const body = {
  displayName: requiredString(raw.displayName, 'displayName', 240),
  publicModelId: modelSelection(raw.publicModelId, 'publicModelId'),
  instructions: requiredString(raw.instructions, 'instructions', 100000),
  entryPoints: raw.entryPoints === undefined ? [] : stringArray(raw.entryPoints, 'entryPoints', 100, 240),
  skillIds: raw.skillIds === undefined ? [] : stringArray(raw.skillIds, 'skillIds', 100, 240),
  mcpServerIds: raw.mcpServerIds === undefined ? [] : stringArray(raw.mcpServerIds, 'mcpServerIds', 100, 240),
  toolNames: raw.toolNames === undefined ? [] : stringArray(raw.toolNames, 'toolNames', 100, 240),
  ...(raw.executor === undefined ? {} : { executor: oneOf(raw.executor, 'executor', ['claude', 'codex']) }),
};
const coderId = requiredString(raw.coderId, 'coderId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId) + '/roles', { method: 'POST', body });
print({ worklite: { type: 'coder', id: data.id }, data });
`],
  ['scripts/update-coder-role.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, modelSelection, oneOf, print, requiredString, stringArray } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'roleId', 'displayName', 'publicModelId', 'instructions', 'entryPoints', 'skillIds', 'mcpServerIds', 'toolNames', 'executor']);
const body = {};
for (const key of ['displayName', 'instructions']) if (raw[key] !== undefined) body[key] = requiredString(raw[key], key, 100000);
if (raw.publicModelId !== undefined) body.publicModelId = modelSelection(raw.publicModelId, 'publicModelId');
for (const key of ['entryPoints', 'skillIds', 'mcpServerIds', 'toolNames']) if (raw[key] !== undefined) body[key] = stringArray(raw[key], key, 100, 240);
if (raw.executor !== undefined) body.executor = raw.executor === null ? null : oneOf(raw.executor, 'executor', ['claude', 'codex']);
if (!Object.keys(body).length) throw new Error('Provide at least one role field to update.');
const coderId = requiredString(raw.coderId, 'coderId', 240);
const roleId = requiredString(raw.roleId, 'roleId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId) + '/roles/' + encodeURIComponent(roleId), { method: 'PATCH', body });
print({ worklite: { type: 'coder', id: data.id }, data });
`],
  ['scripts/delete-coder-role.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'roleId']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const roleId = requiredString(raw.roleId, 'roleId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId) + '/roles/' + encodeURIComponent(roleId), { method: 'DELETE' });
print({ worklite: { type: 'coder', id: data.id }, data });
`],
  ['scripts/inspect-coder-memories.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'repositoryId']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const all = await call('/coders/' + encodeURIComponent(coderId) + '/memories');
const data = all.filter((memory) => raw.repositoryId === undefined || memory.repositoryId === raw.repositoryId);
print({ worklite: { type: 'coder-memories', id: coderId }, data });
`],
  ['scripts/create-coder-memory.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'content', 'repositoryId']);
const body = { content: requiredString(raw.content, 'content', 100000) };
if (raw.repositoryId !== undefined && raw.repositoryId !== '') body.repositoryId = raw.repositoryId === null ? null : requiredString(raw.repositoryId, 'repositoryId', 240);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId) + '/memories', { method: 'POST', body });
print({ worklite: { type: 'coder-memory', id: data.id }, data });
`],
  ['scripts/update-coder-memory.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'memoryId', 'content', 'repositoryId']);
const body = {};
if (raw.content !== undefined) body.content = requiredString(raw.content, 'content', 100000);
if (raw.repositoryId !== undefined) body.repositoryId = raw.repositoryId === null ? null : requiredString(raw.repositoryId, 'repositoryId', 240);
if (!Object.keys(body).length) throw new Error('Provide at least one Coder memory field to update.');
const coderId = requiredString(raw.coderId, 'coderId', 240);
const memoryId = requiredString(raw.memoryId, 'memoryId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId) + '/memories/' + encodeURIComponent(memoryId), { method: 'PATCH', body });
print({ worklite: { type: 'coder-memory', id: data.id }, data });
`],
  ['scripts/delete-coder-memory.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId', 'memoryId']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const memoryId = requiredString(raw.memoryId, 'memoryId', 240);
await call('/coders/' + encodeURIComponent(coderId) + '/memories/' + encodeURIComponent(memoryId), { method: 'DELETE' });
print({ worklite: { type: 'coder-memory', id: memoryId }, data: { deleted: memoryId } });
`],
  ['scripts/inspect-coder-records.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['coderId']);
const coderId = requiredString(raw.coderId, 'coderId', 240);
const data = await call('/coders/' + encodeURIComponent(coderId) + '/runs');
print({ worklite: { type: 'coder-records', id: coderId }, data });
`],
  ['scripts/inspect-coder-group.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['groupId']);
const groupId = requiredString(raw.groupId, 'groupId', 240);
const data = await call('/coder-groups/' + encodeURIComponent(groupId));
print({ worklite: { type: 'coder-group', id: data.id }, data });
`],
  ['scripts/control-coder-group.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString, stringArray } from './lib.mjs';
const raw = input();
exactKeys(raw, ['groupId', 'operation', 'runIds', 'runId', 'taskAttemptId']);
const groupId = requiredString(raw.groupId, 'groupId', 240);
const operation = oneOf(raw.operation, 'operation', ['reexecute', 'stop_task', 'continue_task']);
let body;
if (operation === 'reexecute') {
  if (raw.runId !== undefined || raw.taskAttemptId !== undefined) throw new Error('reexecute accepts runIds only.');
  body = { operation, runIds: stringArray(raw.runIds, 'runIds', 100, 240) };
} else {
  if (raw.runIds !== undefined) throw new Error(operation + ' accepts runId and taskAttemptId only.');
  body = {
    operation,
    runId: requiredString(raw.runId, 'runId', 240),
    taskAttemptId: requiredString(raw.taskAttemptId, 'taskAttemptId', 240),
  };
}
const data = await call('/coder-groups/' + encodeURIComponent(groupId) + '/controls', { method: 'POST', body });
print({ worklite: { type: 'coder-group', id: groupId, operation }, data });
`],
  ['scripts/inspect-coder-document.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['documentId']);
const documentId = requiredString(raw.documentId, 'documentId', 240);
const data = await call('/coder-documents/' + encodeURIComponent(documentId));
print({ worklite: { type: 'coder-document', id: data.id, runId: data.runId }, data });
`],
  ['scripts/inspect-coder-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId']);
const runId = requiredString(raw.runId, 'runId', 240);
const data = await call('/coder-runs/' + encodeURIComponent(runId));
const commandIds = [...new Set((data.activities ?? []).map((event) => event.payload?.commandExecutionId).filter((id) => typeof id === 'string'))];
const backendCommands = await Promise.all(commandIds.map((id) => call('/commands/' + encodeURIComponent(id))));
print({ worklite: { type: 'coder-run', id: data.id }, data, backendCommands });
`],
  ['scripts/answer-coder-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString, stringArray, text } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'pendingInputId', 'scopeRevision', 'answer', 'directories']);
if (!Number.isInteger(raw.scopeRevision) || raw.scopeRevision < 1) throw new Error('scopeRevision must be a positive integer.');
const body = {
  pendingInputId: requiredString(raw.pendingInputId, 'pendingInputId', 240),
  scopeRevision: raw.scopeRevision,
  answer: text(raw.answer, 'answer', 100000),
};
if (raw.directories !== undefined) body.directories = stringArray(raw.directories, 'directories', 10, 1000);
const runId = requiredString(raw.runId, 'runId', 240);
const result = await call('/coder-runs/' + encodeURIComponent(runId) + '/answer', { method: 'POST', body });
print({ worklite: { type: 'coder-run-action', action: 'answer', runId: result.run.id }, data: result.run });
`],
  ['scripts/recover-coder-operation.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'operationKey', 'decision']);
const body = {
  operationKey: requiredString(raw.operationKey, 'operationKey', 1000),
  decision: oneOf(raw.decision, 'decision', ['adopt_command', 'mark_failed', 'replay']),
};
const runId = requiredString(raw.runId, 'runId', 240);
const path = '/coder-runs/' + encodeURIComponent(runId) + '/operations/' + encodeURIComponent(body.operationKey) + '/recovery';
const result = await call(path, { method: 'POST', body });
print({ worklite: { type: 'coder-run-action', action: 'recover', runId: result.run.id }, data: result.run });
`],
  ['scripts/cancel-agent-execution.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['agentId', 'executionId', 'runId']);
const agentId = requiredString(raw.agentId, 'agentId', 240);
const executionId = requiredString(raw.executionId, 'executionId', 240);
const runId = raw.runId === undefined ? undefined : requiredString(raw.runId, 'runId', 240);
const path = '/agents/' + encodeURIComponent(agentId) + '/executions/' + encodeURIComponent(executionId)
  + (runId ? '/sub-agents/' + encodeURIComponent(runId) : '') + '/cancel';
const data = await call(path, { method: 'POST', body: {} });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/control-coder-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'action']);
const runId = requiredString(raw.runId, 'runId', 240);
const action = oneOf(raw.action, 'action', ['cancel']);
const result = await call('/coder-runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST', body: {} });
print({ worklite: { type: 'coder-run-action', action, runId: result.run.id }, data: result.run });
`],
  ['scripts/update-settings.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print } from './lib.mjs';
const raw = input();
exactKeys(raw, ['appearance']);
const body = {};
if ('appearance' in raw) body.appearance = oneOf(raw.appearance, 'appearance', ['system', 'light', 'dark']);
if (Object.keys(body).length === 0) throw new Error('At least one setting is required.');
const settings = await call('/settings', { method: 'PATCH', body });
print({ worklite: { type: 'settings', appearance: settings.appearance }, data: settings });
`],
  ['scripts/navigate.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['target']);
const value = requiredString(raw.target, 'target', 240);
let target;
if (value.startsWith('/workflows/')) {
  // Resolve one workflow by exact id first, then by exact unique name, and send the canonical editor target.
  const reference = value.slice('/workflows/'.length);
  const workflows = await call('/workflows');
  const byId = workflows.find((workflow) => workflow.id === reference);
  const byName = workflows.filter((workflow) => workflow.name === reference);
  const workflow = byId ?? (byName.length === 1 ? byName[0] : null);
  if (!workflow) throw new Error(byName.length > 1 ? 'Multiple Workflows share this name; navigate by workflowId.' : 'Workflow not found.');
  target = '/workflows/' + workflow.id;
} else {
  target = oneOf(value, 'target', ['home', 'chat', 'skills', 'mcp-servers', 'model-providers', 'logs', 'agents', 'settings-appearance', 'settings-usage', 'settings-audit-log']);
}
const action = await call('/navigation/resolve', { method: 'POST', body: { target } });
print({ worklite: action });
`],
  ['scripts/list-memories.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, optionalString, print } from './lib.mjs';
const raw = input(false);
exactKeys(raw, ['category', 'memoryId']);
const CATEGORIES = ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'];
const category = raw.category === undefined ? undefined : oneOf(raw.category, 'category', CATEGORIES);
const memoryId = optionalString(raw.memoryId, 'memoryId', 240);
if (memoryId) {
  const data = await call('/chat/memories/' + encodeURIComponent(memoryId));
  print({ worklite: { type: 'snapshot' }, data });
} else {
  const data = await call('/chat/memories' + (category ? '?category=' + encodeURIComponent(category) : ''));
  print({ worklite: { type: 'snapshot' }, data });
}
`],
  ['scripts/save-memory.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['content', 'category']);
const content = requiredString(raw.content, 'content', 2000);
const CATEGORIES = ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'];
const category = raw.category === undefined ? undefined : oneOf(raw.category, 'category', CATEGORIES);
// The server conversation context records which conversation produced this memory.
const sourceConversationId = process.env.WORKLITE_CHAT_EXECUTION_ID || undefined;
const data = await call('/chat/memories', { method: 'POST', body: { content, ...(category ? { category } : {}), ...(sourceConversationId ? { sourceConversationId } : {}) } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/update-memory.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, optionalString, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['memoryId', 'content', 'category']);
const memoryId = requiredString(raw.memoryId, 'memoryId', 240);
const content = optionalString(raw.content, 'content', 2000);
const CATEGORIES = ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'];
const category = raw.category === undefined ? undefined : oneOf(raw.category, 'category', CATEGORIES);
if (content === undefined && category === undefined) throw new Error('At least one of content or category is required.');
const data = await call('/chat/memories/' + encodeURIComponent(memoryId), { method: 'PATCH', body: { ...(content === undefined ? {} : { content }), ...(category === undefined ? {} : { category }) } });
print({ worklite: { type: 'snapshot' }, data });
`],
  ['scripts/delete-memory.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input(); exactKeys(raw, ['memoryId']);
const memoryId = requiredString(raw.memoryId, 'memoryId', 240);
await call('/chat/memories/' + encodeURIComponent(memoryId), { method: 'DELETE' });
print({ worklite: { type: 'snapshot' }, data: { deleted: memoryId } });
`],
  ['scripts/tools.json', JSON.stringify(WORKLITE_PLATFORM_TOOLS, null, 2)],
];

export function platformSkillPackageFiles(): Array<{ path: string; content: string }> {
  return WORKLITE_PLATFORM_FILES.filter(([path]) => !path.includes('workflow') && !path.includes('coder') && path !== 'scripts/dispatch-task.mjs').map(([path, content]) => ({
    path,
    content,
  }));
}

export function createDb(filePath: string) {
  const path = filePath === ':memory:' ? filePath : (isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath));
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new BetterSqlite3(path);
  // WAL keeps readers off the writer's lock; rollback mode made every read wait behind
  // the continuous event-stream writes. busy_timeout turns lock contention into a wait
  // instead of an immediate SQLITE_BUSY error.
  if ((client.pragma('page_count', { simple: true }) as number) === 0) client.pragma('auto_vacuum = INCREMENTAL');
  client.pragma('journal_mode = WAL');
  client.pragma('busy_timeout = 5000');
  client.pragma('foreign_keys = ON');
  applyWalSizeLimit(client, databaseMaintenanceSettings());
  client.function('worklite_unpack_json', (value: string | null) => value?.startsWith('worklite:z1:') ? JSON.stringify(unpackJson(value)) : value);
  client.function('worklite_runtime_kind', (value: string | null) => value ? unpackJson<{ agent?: { runtime?: { kind?: string } } }>(value).agent?.runtime?.kind ?? null : null);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

type RestartAgentToolCall = {
  tool_name: string;
  mcp_server_id: string | null;
  mcp_tool_name: string | null;
};

function restartModelToolName(call: RestartAgentToolCall): string {
  if (call.tool_name === 'builtin') return call.mcp_tool_name ?? 'builtin';
  if (call.tool_name === 'mcp' && call.mcp_server_id && call.mcp_tool_name) return `mcp_${call.mcp_server_id}_${call.mcp_tool_name}`;
  if (call.tool_name === 'skill_script') return call.mcp_tool_name ?? 'skill_script';
  return call.tool_name;
}

export async function initializeDatabase(db: Database): Promise<void> {
  const migrationsFolder = [
    resolve(process.cwd(), 'packages/db/drizzle'),
    resolve(process.cwd(), '../../packages/db/drizzle'),
  ].find((candidate) => existsSync(candidate));
  if (!migrationsFolder) throw new Error('Drizzle migrations folder could not be located.');
  migrate(db, { migrationsFolder });
  installStoredArrayStorage(db.$client);
  // Retention and vacuum run on a separate connection in the maintenance worker.

  const workflowRows = db.$client.prepare('SELECT id, workspace_id FROM workflows').all() as Array<{ id: string; workspace_id: string }>;
  const workflowVersionQuery = db.$client.prepare(`
    SELECT id, nodes, definition, schema_version
    FROM workflow_versions
    WHERE workflow_id = ?
    ORDER BY published ASC, version DESC
    LIMIT 1
  `);
  const draftInsert = db.$client.prepare(`
    INSERT OR IGNORE INTO workflow_drafts (id, workspace_id, workflow_id, current_revision_id, definition)
    VALUES (?, ?, ?, ?, ?)
  `);
  const revisionInsert = db.$client.prepare(`
    INSERT OR IGNORE INTO workflow_edit_revisions (id, workspace_id, workflow_id, draft_id, parent_revision_id, source, source_instruction, operations, snapshot)
    VALUES (?, ?, ?, ?, NULL, 'migration', 'Imported from the legacy workflow version snapshot.', '[]', ?)
  `);
  const versionDefinitionUpdate = db.$client.prepare('UPDATE workflow_versions SET definition = COALESCE(definition, ?), published_at = CASE WHEN published = 1 AND published_at IS NULL THEN created_at ELSE published_at END WHERE id = ?');
  for (const workflow of workflowRows) {
    const draftId = `wfd_${workflow.id}`;
    const revisionId = `wfr_migration_${workflow.id}`;
    const existingDraft = db.$client.prepare('SELECT id FROM workflow_drafts WHERE workflow_id = ? LIMIT 1').get(workflow.id) as { id: string } | undefined;
    if (existingDraft) continue;
    const version = workflowVersionQuery.get(workflow.id) as { id: string; nodes: string; definition: string | null; schema_version: number } | undefined;
    let definition = schema.emptyWorkflowDefinition;
    if (version?.definition) {
      try {
        definition = JSON.parse(version.definition) as typeof definition;
      } catch {
        definition = schema.emptyWorkflowDefinition;
      }
    } else if (version?.nodes) {
      try {
        definition = { ...schema.emptyWorkflowDefinition, schemaVersion: version.schema_version, nodes: JSON.parse(version.nodes) as schema.StoredWorkflowNode[] };
      } catch {
        definition = schema.emptyWorkflowDefinition;
      }
    }
    if (version) versionDefinitionUpdate.run(JSON.stringify(definition), version.id);
    draftInsert.run(draftId, workflow.workspace_id, workflow.id, revisionId, JSON.stringify(definition));
    revisionInsert.run(revisionId, workflow.workspace_id, workflow.id, draftId, JSON.stringify(definition));
  }

  if (process.env.WORKLITE_PREFLIGHT !== '1') { migrateCodersToAgents(db.$client); migrateWorkflowsToAgents(db.$client); }

  const retiredShellQuestions = db.$client.prepare(`
    SELECT e.id, e.workspace_id, CASE WHEN e.model_messages <> '[]' THEN e.model_messages ELSE coalesce((SELECT json_group_array(json(value)) FROM (SELECT value FROM stored_json_items WHERE owner_id = e.id AND kind = 'model' ORDER BY position)), '[]') END AS model_messages, c.id AS call_id, c.tool_call_id
    FROM agent_executions e
    JOIN agent_tool_calls c ON c.id = json_extract(e.pending_question, '$.shellCallId') AND c.execution_id = e.id
    WHERE e.agent_id = 'agt_system_helper_chat' AND e.status = 'waiting_for_input'
      AND json_extract(e.pending_question, '$.commands') = 1
      AND c.tool_name = 'builtin' AND c.mcp_tool_name = 'bash' AND c.status = 'running'
      AND c.command_execution_id IS NULL AND c.result_appended = 0
      AND json_extract(c.shell, '$.state') = 'awaiting_authorization'
  `).all() as Array<{ id: string; workspace_id: string; model_messages: string; call_id: string; tool_call_id: string }>;
  for (const execution of retiredShellQuestions) {
    const output = '逐条命令授权提问已失效，本轮已取消；该命令未执行。';
    const modelMessages = [...JSON.parse(execution.model_messages), { role: 'tool', content: [{ type: 'tool-result', toolCallId: execution.tool_call_id, toolName: 'bash', output: { type: 'error-text', value: output } }] }];
    db.$client.transaction(() => {
      const now = Date.now();
      db.$client.prepare(`UPDATE agent_tool_calls SET status = 'cancelled', shell = json_set(shell, '$.state', 'settled'), output = ?, result_appended = 1, finished_at = ? WHERE id = ?`).run(output, now, execution.call_id);
      db.$client.prepare(`UPDATE agent_executions SET status = 'cancelled', pending_question = NULL, execution_authorization = NULL, model_messages = ?, error = NULL, error_code = NULL, updated_at = ? WHERE id = ?`).run(JSON.stringify(modelMessages), now, execution.id);
      db.insert(schema.auditLogs).values({ id: `audit_${randomUUID()}`, workspaceId: execution.workspace_id, action: 'chat_execution.question_retired', resource: execution.id, metadata: { agentId: 'agt_system_helper_chat', executionId: execution.id, toolCallId: execution.call_id, commandExecutionId: null, commandStarted: false } }).run();
    })();
  }

  const staleExecutions = db.$client.prepare(`
    SELECT id, workspace_id, agent_id, CASE WHEN model_messages <> '[]' THEN model_messages ELSE coalesce((SELECT json_group_array(json(value)) FROM (SELECT value FROM stored_json_items WHERE owner_id = agent_executions.id AND kind = 'model' ORDER BY position)), '[]') END AS model_messages,
      EXISTS (SELECT 1 FROM agent_sub_sessions WHERE agent_sub_sessions.execution_id = agent_executions.id) AS has_sub_session
    FROM agent_executions
    WHERE status = 'running'
  `).all() as Array<{ id: string; workspace_id: string; agent_id: string; model_messages: string; has_sub_session: number }>;
  const staleToolCalls = staleExecutions.length > 0
    ? db.$client.prepare(`
        SELECT id, workspace_id, execution_id, tool_call_id, tool_name, mcp_server_id, mcp_tool_name, shell, skill_id, script_path, command_execution_id, package_files
        FROM agent_tool_calls
        WHERE status = 'running' AND result_appended = 0 AND execution_id IN (SELECT id FROM agent_executions WHERE status = 'running')
        ORDER BY rowid
      `).all() as Array<{ id: string; workspace_id: string; execution_id: string; tool_call_id: string; tool_name: string; mcp_server_id: string | null; mcp_tool_name: string | null; shell: unknown; skill_id: string | null; script_path: string | null; command_execution_id: string | null; package_files: string }>
    : [];
  const restartResults = new Map<string, StoredAgentModelMessage[]>();
  for (const execution of staleExecutions) {
    const modelMessages = JSON.parse(execution.model_messages) as StoredAgentModelMessage[];
    const calls = staleToolCalls.filter((call) => call.execution_id === execution.id);
    const closures = calls
      .filter((call) => call.shell === null && !(call.tool_name === 'builtin' && call.mcp_tool_name === 'project_task'))
      .filter((call) => !modelMessages.some((message) => message?.role === 'tool' && message.content.some((result) => result.toolCallId === call.tool_call_id)))
      .map((call) => ({
        type: 'tool-result' as const,
        toolCallId: call.tool_call_id,
        toolName: restartModelToolName(call),
        output: { type: 'error-text' as const, value: call.tool_name === 'skill_script' ? JSON.stringify({ failure: platformFailure('execution', 'PLATFORM_API_RESTARTED', 'unknown'), commandExecutionId: call.command_execution_id }) : 'The API restarted before this Agent tool execution completed. Outcome unknown; inspect effects before retrying.' },
      }));
    if (closures.length > 0) restartResults.set(execution.id, insertAgentToolResults(modelMessages, closures));
  }
  if (staleExecutions.length > 0) {
    db.$client.transaction(() => {
      db.$client.prepare(`
        UPDATE agent_tool_calls SET shell = json_set(shell, '$.state', 'uncertain')
          WHERE status = 'running' AND shell IS NOT NULL AND command_execution_id IS NOT NULL
            AND execution_id IN (SELECT id FROM agent_executions WHERE status = 'running')
      `).run();
      db.$client.prepare(`
        UPDATE agent_tool_calls
          SET status = 'failed', output = 'The API restarted before this Agent tool execution completed.', result_appended = CASE WHEN mcp_tool_name = 'project_task' OR shell IS NOT NULL THEN 0 ELSE 1 END, finished_at = unixepoch() * 1000
          WHERE status = 'running' AND result_appended = 0 AND execution_id IN (SELECT id FROM agent_executions WHERE status = 'running')
      `).run();
      for (const call of staleToolCalls.filter((item) => item.tool_name === 'skill_script')) {
        const failure = platformFailure('execution', 'PLATFORM_API_RESTARTED', 'unknown');
        db.$client.prepare('UPDATE agent_tool_calls SET output = ? WHERE id = ?').run(JSON.stringify({ failure, commandExecutionId: call.command_execution_id }), call.id);
        db.insert(schema.auditLogs).values({ id: `failure_${call.id}`, workspaceId: call.workspace_id, action: 'platform.tool_failure', resource: call.id, metadata: { executionId: call.execution_id, toolCallId: call.tool_call_id, skillId: call.skill_id, scriptPath: call.script_path, commandExecutionId: call.command_execution_id, contractHash: platformContractHash(unpackJson<Array<{ path: string; content: string }>>(call.package_files)), failure } }).onConflictDoNothing().run();
      }
      db.$client.prepare(`
        UPDATE command_executions
          SET status = 'failed', signal = 'SIGHUP', finished_at = unixepoch() * 1000
          WHERE status IN ('queued', 'running', 'cancelling')
            AND id IN (SELECT command_execution_id FROM agent_tool_calls WHERE execution_id IN (SELECT id FROM agent_executions WHERE status = 'running'))
      `).run();
      db.$client.prepare(`
        UPDATE agent_sub_sessions
          SET unread = 1, updated_at = unixepoch() * 1000
          WHERE execution_id IN (SELECT id FROM agent_executions WHERE status = 'running')
      `).run();
      db.$client.prepare(`
        UPDATE agent_executions
          SET status = 'failed', phase = 'recovery', error_code = 'restarted', error = 'The API restarted before this Agent turn completed.', updated_at = unixepoch() * 1000
          WHERE status = 'running'
      `).run();
      const modelMessagesUpdate = db.$client.prepare('UPDATE agent_executions SET model_messages = ? WHERE id = ?');
      for (const [executionId, modelMessages] of restartResults) modelMessagesUpdate.run(JSON.stringify(modelMessages), executionId);
      for (const execution of staleExecutions) {
        db.insert(schema.auditLogs).values({
          id: `audit_${randomUUID()}`,
          workspaceId: execution.workspace_id,
          action: 'agent_execution.restarted',
          resource: execution.id,
          metadata: { agentId: execution.agent_id, executionId: execution.id, phase: 'recovery', errorCode: 'restarted', hasSubSession: Boolean(execution.has_sub_session) },
        }).run();
      }
    })();
  }

  const staleWorkflowRuns = db.$client.prepare(`
    SELECT id, workspace_id, workflow_id
    FROM workflow_runs
    WHERE status IN ('queued', 'running')
  `).all() as Array<{ id: string; workspace_id: string; workflow_id: string }>;
  if (staleWorkflowRuns.length > 0) {
    db.$client.exec(`
      UPDATE workflow_node_runs
        SET status = 'failed', error = 'The API restarted before this Workflow node completed.', finished_at = unixepoch() * 1000
        WHERE status IN ('queued', 'running')
          AND run_id IN (SELECT id FROM workflow_runs WHERE status IN ('queued', 'running'));
      INSERT INTO workflow_run_events (run_id, sequence, type, payload)
        SELECT workflow_runs.id,
          COALESCE((SELECT MAX(sequence) + 1 FROM workflow_run_events WHERE workflow_run_events.run_id = workflow_runs.id), 1),
          'run.status',
          '{"status":"failed","error":"The API restarted before this Workflow run completed."}'
        FROM workflow_runs
        WHERE status IN ('queued', 'running');
      UPDATE workflow_runs
        SET status = 'failed', current_node_id = NULL,
          result = '{"error":"The API restarted before this Workflow run completed."}',
          finished_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
        WHERE status IN ('queued', 'running');
    `);
    for (const run of staleWorkflowRuns) {
      db.insert(schema.auditLogs).values({
        id: `audit_${randomUUID()}`,
        workspaceId: run.workspace_id,
        action: 'workflow_run.restarted',
        resource: run.id,
        metadata: { workflowId: run.workflow_id, runId: run.id, errorCode: 'restarted' },
      }).run();
    }
  }

  db.$client.exec(`
    UPDATE workflow_pending_actions
      SET status = 'expired', qr_code = NULL, updated_at = unixepoch() * 1000
      WHERE status = 'pending' AND run_id IN (SELECT id FROM workflow_runs WHERE status = 'waiting_for_input');
    UPDATE wechat_official_accounts
      SET status = CASE WHEN encrypted_storage_state IS NULL THEN 'disconnected' ELSE status END,
          qr_code = NULL, qr_expires_at = NULL, updated_at = unixepoch() * 1000
      WHERE status = 'qr_pending';
  `);


  db.$client.exec(`
    UPDATE chat_codex_operations SET status = 'uncertain', failure_reason = 'API restarted before effect completion.', updated_at = unixepoch() * 1000 WHERE status = 'reserved';
    UPDATE chat_codex_tasks SET status = 'failed', error = 'API 已重启，任务被中断且未重放；请先检查项目的实际状态。', reported_at = unixepoch() * 1000, updated_at = unixepoch() * 1000 WHERE status = 'running';
    -- A Claude Agent SDK session is in-process state: it cannot survive an API restart, so a task
    -- left waiting_for_input on a Claude launch was waiting on a live session that no longer
    -- exists, not on durable state the way a Codex (deny-and-rerun) question is. It is marked
    -- interrupted the same as a running task; its activities and pending question are kept as
    -- evidence (view() reports pendingQuestion regardless of status), and answering it is refused
    -- by status, never silently resumed into a new session or replayed.
    UPDATE chat_codex_tasks SET status = 'failed', error = 'API 已重启，等待回答的 Claude 会话已中断且未重放；请先检查项目的实际状态，再创建新任务。', reported_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
      WHERE status = 'waiting_for_input' AND json_extract(worklite_unpack_json(snapshot), '$.launch.executor') = 'claude';
  `);

  db.$client.exec(`
    DELETE FROM agents WHERE id = 'agt_agent_chat';
    INSERT INTO workspaces (id, slug, name) VALUES ('workspace_personal', 'personal', 'Personal Workspace') ON CONFLICT (slug) DO NOTHING;
    INSERT INTO workspace_settings (workspace_id) SELECT id FROM workspaces WHERE slug = 'personal' ON CONFLICT (workspace_id) DO NOTHING;
    INSERT INTO model_providers (id, workspace_id, name, protocol, status, masked_key, models)
      SELECT 'gateway-provider', workspaces.id, 'WorkLite Gateway Provider', 'openai/chat', 'connected', '', '[]'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, protocol = excluded.protocol;
    INSERT INTO chat_channels (id, workspace_id)
      SELECT 'feishu', id FROM workspaces WHERE slug = 'personal'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO chat_channels (id, workspace_id)
      SELECT 'wechat', id FROM workspaces WHERE slug = 'personal'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO wechat_official_accounts (id, workspace_id, display_name)
      SELECT 'wechat_official_account_personal', workspaces.id, 'Personal Official Account'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, model)
      SELECT 'agt_system_helper_chat', workspaces.id, 'system', 'Chat', 'Handle dialogue and delegate tasks to Agents', '${CHAT_PROMPT.replaceAll("'", "''")}', ''
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET kind = 'system', name = 'Chat', responsibility = 'Handle dialogue and delegate tasks to Agents', system_prompt = excluded.system_prompt;
  `);

  db.$client.exec(`
    INSERT INTO skill_files (skill_id, path, content)
      SELECT id, 'SKILL.md', instructions FROM skills WHERE true
      ON CONFLICT (skill_id, path) DO NOTHING;
    INSERT INTO chat_bot_configurations (workspace_id, revision, extension_prompt, provider_id, model, skill_ids, mcp_server_ids)
    SELECT a.workspace_id, 1, '', a.provider_id, a.model,
      json_array(), json_array()
    FROM agents a WHERE a.id = 'agt_system_helper_chat'
      AND NOT EXISTS (SELECT 1 FROM chat_bot_configurations c WHERE c.workspace_id = a.workspace_id);
  `);
  migrateCodexProviders(db.$client);
}
