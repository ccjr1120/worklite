import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

const TERMINAL_COMMAND_SKILL_MD = `# terminal-command

Use \`scripts/run.sh\` only when a Unix shell command directly advances the user request.

Pass exactly one argument containing the complete command string. Do not split the command into multiple arguments. The script delegates to /bin/sh -lc in the API process working directory with the WorkLite process user host permissions and complete environment. Every valid Agent script call executes immediately without browser approval. Never include secrets in a command and never claim execution until the script result is returned.`;

const TERMINAL_COMMAND_RUN_SH = `#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: run.sh <command>" >&2
  exit 64
fi

exec /bin/sh -lc "$1"
`;

const CHAT_BOT_PROMPT = `You are Chat Bot, the WorkLite workspace assistant.
Use only assigned Skill scripts for platform inspection and operations. For product capability questions, rely on the assigned Skill knowledge and the current workspace snapshot. Never invent configured resources, models, MCP tools, script results, or platform capabilities.
The development profile uses Web port 3390, API port 3391, and Portkey Gateway port 3392. The local deployment profile uses Web port 23390, API port 23391, and Portkey Gateway port 23392. Do not suggest compatibility listeners for previous development ports.
Model Provider drafts require an explicit protocol selection. Supported protocols are \`openai/chat\`, \`openai/responses\`, \`anthropic/messages\`, \`codex/responses\`, and \`typesafe/systemone\`; do not invent or default another protocol. System One exchanges typed \`state\` and \`questions\` for typed \`answers\`, has no model-discovery endpoint, and cannot run a Workflow Agent node. It can be used through the dedicated \`typesafe/systemone@1\` Workflow node, which stores a public model id and typed questions, accepts JSON state, retains object state fields, and exposes typed answers. Its connection test uses a typed state/question payload and returns typed answers; it is not a chat test. Existing \`deepseek/chat\` records are not migrated or aliased.
The unified Provider proxy supports Codex image generation at \`/api/portkey-gateway/v1/images/generations\` with the public model \`codex/gpt-image-2\`; it returns base64 image JSON and does not support image edits. Workflows can use the first-party \`worklite/image@1\` node instead: it requires \`prompt\`, fixes the model to \`codex/gpt-image-2\`, retains generated PNG data only in scheduler execution state, and exposes image summaries in public logs, results, and events. Image output may connect only to the WeChat v2 \`coverImage\` input.
For TypeSafe Workflow automation, use \`typesafe/systemone@1\` with \`config.model\` set to the public \`<providerName>/<modelId>\` value, \`config.questions\` as the immutable typed question object, and a required \`state\` input from a JSON-producing upstream node. The node output retains object state fields and overlays the upstream System One response, including \`answers\`; primitive or array state is exposed under \`state\`. Route typed results with structured paths such as \`$.answers.articleType.choice\`. Do not put credentials, base URLs, or Provider ids in the Workflow plan.
TypeSafe Workflow node output retains object state fields alongside the upstream typed response; primitive and array state is exposed under \`state\`. This allows a typed classification to route the original Workflow context without adding a merge node. Gateway transport remains unchanged.
For per-element typed evaluation use \`typesafe/systemone-map@1\`: same \`model\`, \`questions\`, and required \`state\` input, plus a required \`config.itemsPath\` addressing an array inside that state, an optional \`config.contextPath\` for shared context, an optional positive \`config.concurrency\`, and an optional \`config.rank\` of \`path\`, \`order\`, \`limit\`, and \`minimum\`. It sends one upstream request per element with state \`{ item, context }\`, commits \`results\` as those elements with their typed \`answers\` merged in, and applies \`rank\` as deterministic server-side ordering and truncation. Iteration stays inside one node invocation, so it is not a port-level join and produces one NodeRun. Use it for reranking, per-candidate screening, and per-claim checks instead of asking one call to judge a whole array.
Use worklite/branch@1 for reusable JSON routing: it requires a value input, passes the original JSON through output, and takes only the first matching outgoing condition edge in definition order, or the first fallback edge when none matches. Its paths can target any JSON producer, such as $.articleType or a typed answer path exposed by the current upstream node.
Workflow Run lifecycle supports pause for queued or running Runs via POST /runs/:runId/pause and resume for paused Runs via POST /runs/:runId/resume. Pause has no checkpoint inside the active invocation: resume reruns that invocation from its start without rerunning successful predecessors, does not pause waiting_for_input Runs, keeps the event stream open, survives restart as paused, remains cancellable, and blocks overlapping scheduled execution.
Chat Bot Agent Team operations use the assigned worklite-platform scripts. WorkLite also provides direct built-in Team and Team Run Web routes; the Chat Bot starter only navigates to the Team route and does not extend @ Workflow dispatch. There is one built-in Team, and Team creation and deletion are unavailable. Runs can answer pending input, pause, resume, cancel, recover an uncertain operation, and retry the server-declared failed active task. Command execution requires exact-string authorization supplied through structured script fields.
Never ask the user to paste API keys, tokens, passwords, or other secrets into conversation or script arguments. Provider credentials must be entered in the dedicated secure form.
Before claiming a platform operation completed, wait for the script result. Keep responses concise and practical.`;

const WORKLITE_PLATFORM_SKILL_MD = `# worklite-platform

Use the exact scripts in this package for WorkLite platform operations.

Use \`scripts/inspect-workspace.mjs\` before answering questions about configured resources or Workflow capabilities. Creation, settings, and navigation scripts accept exactly one JSON object argument. Every valid Agent script call executes automatically after server validation. Provider scripts never accept credentials; direct the user to the secure Provider form after creation.

Use \`scripts/inspect-agent-teams.mjs\` and \`scripts/inspect-agent-team.mjs\` for current Team configuration, then the dedicated update, Run, answer, recovery, and control scripts. WorkLite also provides direct built-in Team and Team Run Web routes; do not claim a Team collection, creation, or deletion route. There is one built-in Team. Inspect the current Run before continuing it and grant Commands only as exact strings in structured script fields.

The development profile uses Web port \`3390\`, API port \`3391\`, and Portkey Gateway port \`3392\`. The local deployment profile remains on Web port \`23390\`, API port \`23391\`, and Portkey Gateway port \`23392\`. Previous development ports have no compatibility listeners or redirects.
Model Provider drafts require an explicit protocol selection. Supported protocols are \`openai/chat\`, \`openai/responses\`, \`anthropic/messages\`, \`codex/responses\`, and \`typesafe/systemone\`; do not invent or default another protocol. System One exchanges typed \`state\` and \`questions\` for typed \`answers\`, has no model-discovery endpoint, and cannot run a Workflow Agent node. It can be used through the dedicated \`typesafe/systemone@1\` Workflow node, which stores a public model id and typed questions, accepts JSON state, retains object state fields, and exposes typed answers. Its connection test uses a typed state/question payload and returns typed answers; it is not a chat test. Existing \`deepseek/chat\` records are not migrated or aliased.

The unified Provider proxy supports Codex image generation at \`/api/portkey-gateway/v1/images/generations\`. The automatic Codex Provider advertises \`codex/gpt-image-2\`; the operation forwards only \`prompt\`, \`model\`, \`n\`, \`background\`, \`quality\`, and \`size\` and returns generated images as \`data[].b64_json\`. It does not support image edits, and no standalone platform script is provided for image generation.

The first-party Workflow node \`worklite/image@1\` wraps that capability. Its required \`prompt\` input accepts text, its model is fixed to \`codex/gpt-image-2\`, and its generated PNG remains internal to Run execution state. Public Run results, node logs, and events contain only an image summary; image output may connect only to \`wechat-official-account/publish@2.coverImage\`. Image edits and binary Artifacts remain unsupported.

Workflow automation and Home are WorkLite's primary product services. Workflows are the only user-configurable execution capability; Chat Bot is the protected workspace entry for guided operations. A Workflow never selects or references a standalone Agent or Agent version; its Agent nodes own their configuration inside immutable Workflow versions. Home has no global Workflow data source. A Workflow appears on Home only when its latest published version contains its one \`worklite/dashboard\` node, and its selected board reads that node's object or object-array output from the latest successful Run of that version. Boards render the Dashboard layout's header, main, and footer elements; list elements define row titles through \`titleKey\` and their display fields, and board titles use the Workflow name. Eligible boards default to Uncategorized; users can move each board into at most one database-backed category, and those records only organize references. Platform-defined Workflow boards are removed. Workflow scheduling is represented by one first-party \`worklite/timer\` node. The first-party node types are Input, Timer, Agent, Choice Branch, TypeSafe System One, TypeSafe System One Map, Dashboard, Artifact, Artifact Query, Approved Article, and Image. The TypeSafe System One node is \`typesafe/systemone@1\`: it requires JSON \`state\`, stores a public Provider/model id and typed \`questions\`, forwards the response unchanged through the Gateway, and exposes typed \`answers\`; it is not an Agent node and has no Workflow-owned credentials. The Image node is \`worklite/image@1\`: it requires a text prompt, fixes the model to \`codex/gpt-image-2\`, returns generated PNG data only inside scheduler execution state, and public Run payloads expose summaries. Its output may connect only to WeChat v2 \`coverImage\`. The built-in \`wechat-official-account/publish\` node has immutable v1 versions that accept Markdown article and optional metadata, while v2 additionally requires a generated \`coverImage\`. Both versions save drafts or publish through a product-owned Playwright browser session. Draft mode succeeds once WeChat accepts the save and exposes a draft id in either the save response or the editor URL's appmsgid parameter; a rejected save reports WeChat's own status text, an accepted save with no exposed id reports that distinct condition, and non-WeChat article links are rendered in the final Related Links section rather than as body links. Login and final confirmation are durable pending actions with QR-only client payloads; completed predecessors are not rerun on resume, and a retried node reopens an existing draft instead of creating a second one. Enabled Timer nodes may use draft mode but cannot use publish mode. Workflow Agent nodes own prompts and Skill/MCP selections; their \`context\` input is optional and may combine one unbounded initial upstream edge with one bounded feedback edge; a Workflow Input edge remains unconditional and unbounded. Artifact nodes own Artifact creation, and Agent and WeChat nodes never create Artifacts.

The first-party \`worklite/branch@1\` Choice Branch node requires JSON on \`value\`, returns the unchanged value on \`output\`, and selects exactly one outgoing route: the first matching predicate in edge-definition order, or the first fallback when no predicate matches. It is reusable with any JSON-producing node and does not depend on a particular Provider protocol.

The first-party \`typesafe/systemone-map@1\` node evaluates one typed question set against every element of an array inside its committed \`state\`. It stores \`model\`, \`questions\`, a required \`itemsPath\`, an optional \`contextPath\`, an optional positive \`concurrency\`, and an optional \`rank\` of \`path\`, \`order\`, \`limit\`, and \`minimum\` in the Workflow version. Each element becomes one upstream request whose state is \`{ item, context }\`, so an element carries only its own content plus the addressed shared context. The node preserves input order, commits \`results\` as the elements with their typed \`answers\` merged in, exposes a non-object element under \`item\`, and retains object state fields beside \`results\` and \`usage\`. A configured \`rank\` orders and truncates deterministically after evaluation and drops an element whose answer path holds no number when \`minimum\` is set. A failed element fails the node under its error policy, so a partially evaluated array is never committed.

The first-party \`typesafe/systemone@1\` node requires JSON on \`state\`, stores \`model\` and \`questions\` in the Workflow version, retains object state fields alongside the upstream response with \`answers\`, exposes primitive or array state under \`state\`, and supports structured answer paths such as \`$.answers.articleType.choice\`. Use a TypeSafe Provider/model from the current snapshot and never add credentials or connection details to a plan.

TypeSafe Workflow node output retains object state fields alongside the upstream typed response; primitive and array state is exposed under \`state\`. This lets a typed classification route the original Workflow context without adding a merge node. Gateway transport remains unchanged.

Workflow node capabilities are dynamic. Always use the current snapshot's \`capabilities.workflow.supportedNodeTypes\` list, including each type, version, purpose, ports, and configuration schema. Do not assume a node exists when it is absent from the snapshot. A logical plan uses model-chosen node keys and edges between those keys; the server generates durable ids and positions.

Published Workflows are executable from workspace chat through \`@Workflow\` mentions. The remaining message text is the Workflow Input, execution uses the latest immutable published version, and Run progress and Artifacts appear in the chat transcript. Draft Workflows are excluded. This chat dispatcher does not turn Workflows into Agents or create Agent sessions.

Workflow Run lifecycle supports pause for queued or running Runs through \`POST /runs/:runId/pause\` and resume for paused Runs through \`POST /runs/:runId/resume\`. Pause has no checkpoint inside the active invocation; resume reruns that invocation from its start without rerunning successful predecessors. Pause does not apply to \`waiting_for_input\` Runs. A paused Run keeps its event stream open, survives an API restart as paused, remains cancellable, and scheduler overlap prevention treats it as active.

Workflow List is the user-facing access point for per-Workflow Run history. Expanded Run rows expose ordered node execution logs with failure reasons, and a failed Run offers a retry control on the single node entry the server marks retryable. They expose Artifacts inline only when the immutable Workflow version contains an Artifact node, and an individual Artifact detail is directly addressable without a standalone Artifact collection destination.

The Logs destination owns Gateway transport observability: request statistics and captured Provider request details, read over one explicit time range shared by both views. Providers configures what the Gateway dispatches to; Logs reads what it did. Statistics are retained indefinitely while captured request details expire after three days, so the same range can legitimately cover more statistics than details. Settings keeps Usage and Audit Log, which are WorkLite business records rather than Gateway transport records.

Workflow Agent context is optional. An Agent context may receive one unbounded initial upstream edge plus one bounded feedback edge; a Workflow Input edge must be unconditional and unbounded. Without an unbounded incoming context edge, its initial invocation uses the Workflow input. Workflow graphs support unconditional, structured predicate, and fallback edges. Predicate edges use a dot-delimited output path and a declared comparison operator; fallback edges run only when no unconditional or predicate edge from the same node invocation matches. An edge may define a positive maxTraversals value, and every cycle must cross at least one such bounded edge. Dynamic joins, parallel execution, webhook triggers, API triggers, notification nodes, and template selection are unavailable unless the current snapshot reports them as supported.

Workflow graphs support unconditional, structured predicate, and fallback edges. A Choice Branch uses those same edge conditions but selects only the first matching non-fallback edge in definition order, then the first fallback when none matches.

Creating a Workflow creates a draft. Use \`scripts/edit-workflow.mjs\` to replace a draft graph from a logical plan; it fetches the current revision, submits an assistant edit, and returns the authoritative Workflow resource.
Scheduling uses the graph Timer node with \`{ "enabled": true, "intervalSeconds": 300 }\`. A Workflow can contain at most one Timer, its interval must be at least 300 seconds, Timer changes become active only after the Workflow is published, and overlapping scheduled runs are prevented. There is no standalone schedule script; \`GET /workflows/:workflowId/schedule\` is read-only runtime status.

Never call arbitrary URLs, access the database directly, delete resources, invoke terminal execution, or claim completion before the script result is returned. See \`references/contracts.md\` for input shapes.`;

const WORKLITE_PLATFORM_LIB_MJS = `const baseUrl = process.env.WORKLITE_API_URL;
if (!baseUrl) throw new Error('WORKLITE_API_URL is unavailable.');

export function input(required = true) {
  if (process.argv.length > 3) throw new Error('Exactly one JSON object argument is allowed.');
  const value = process.argv[2];
  if (!value) {
    if (!required) return {};
    throw new Error('One JSON object argument is required.');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The script argument must be a JSON object.');
  return parsed;
}

export function noInput() {
  if (process.argv.length !== 2) throw new Error('This script does not accept arguments.');
}

export function exactKeys(value, allowed) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error('Unsupported input field: ' + unexpected);
}

export function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(field + ' must be a non-empty string no longer than ' + maxLength + ' characters.');
  return value.trim();
}

export function boundedString(value, field, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(field + ' must be a string no longer than ' + maxLength + ' characters.');
  return value.trim();
}

export function stringValue(value, field) {
  if (typeof value !== 'string') throw new Error(field + ' must be a string.');
  return value.trim();
}

export function text(value, field, maxLength) {
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
  if (!values.includes(value)) throw new Error(field + ' has an unsupported value.');
  return value;
}

export function stringArray(value, field, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength)) throw new Error(field + ' must be an array of non-empty strings.');
  return [...new Set(value.map((item) => item.trim()))];
}

export function authorizedCommands(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('authorizedCommands must be an array.');
  const commands = value.map((command) => {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Every authorized command must be a non-empty string.');
    return command.trim();
  });
  if (new Set(commands).size !== commands.length) throw new Error('Authorized commands must be unique.');
  return commands;
}

export function packageFiles(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('files must be a non-empty package file array.');
  return value.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Every package file must be an object.');
    exactKeys(file, ['path', 'content']);
    return { path: requiredString(file.path, 'file path', 240), content: text(file.content, 'file content', 262144) };
  });
}

export async function call(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    method: options.method || 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch { value = { message: text }; }
  }
  if (!response.ok) throw new Error(value && typeof value.message === 'string' ? value.message : 'WorkLite API request failed.');
  return value;
}

export function print(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
`;

const WORKLITE_PLATFORM_FILES: Array<[string, string]> = [
  ['SKILL.md', WORKLITE_PLATFORM_SKILL_MD],
  ['scripts/lib.mjs', WORKLITE_PLATFORM_LIB_MJS],
  ['scripts/inspect-workspace.mjs', `#!/usr/bin/env node
import { call, noInput, print } from './lib.mjs';
noInput();
const data = await call('/platform/snapshot');
print({ worklite: { type: 'snapshot' }, data });
`],
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
import { call, exactKeys, input, oneOf, packageFiles, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['name', 'source', 'files']);
const body = { name: requiredString(raw.name, 'name', 120), source: oneOf(raw.source, 'source', ['online']), files: packageFiles(raw.files) };
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
  ['scripts/inspect-agent-teams.mjs', `#!/usr/bin/env node
import { call, noInput, print } from './lib.mjs';
noInput();
const data = await call('/agent-teams');
print({ worklite: { type: 'agent-teams' }, data });
`],
  ['scripts/inspect-agent-team.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['teamId']);
const teamId = requiredString(raw.teamId, 'teamId', 240);
const data = await call('/agent-teams/' + encodeURIComponent(teamId));
print({ worklite: { type: 'agent-team', id: data.id }, data });
`],
  ['scripts/update-agent-team.mjs', `#!/usr/bin/env node
import { boundedString, call, exactKeys, input, oneOf, print, requiredString, stringArray } from './lib.mjs';
const roleValues = ['planner', 'test_designer', 'developer', 'test_author', 'test_runner', 'reviewer'];
function roleConfigurations(value) {
  if (!Array.isArray(value) || value.length !== roleValues.length) throw new Error('roles must contain every supported Agent Team role exactly once.');
  return value.map((role) => {
    if (!role || typeof role !== 'object' || Array.isArray(role)) throw new Error('Every Agent Team role configuration must be an object.');
    exactKeys(role, ['role', 'publicModelId', 'instructions', 'entryPoints', 'skillIds', 'mcpServerIds', 'toolNames']);
    return {
      role: oneOf(role.role, 'role', roleValues),
      publicModelId: boundedString(role.publicModelId, 'publicModelId', 240),
      instructions: requiredString(role.instructions, 'instructions', 100000),
      entryPoints: stringArray(role.entryPoints, 'entryPoints', 100, 240),
      skillIds: stringArray(role.skillIds, 'skillIds', 100, 240),
      mcpServerIds: stringArray(role.mcpServerIds, 'mcpServerIds', 100, 240),
      toolNames: stringArray(role.toolNames, 'toolNames', 100, 240),
    };
  });
}
const raw = input();
exactKeys(raw, ['teamId', 'roles']);
const roles = roleConfigurations(raw.roles);
const roleSet = new Set(roles.map((role) => role.role));
if (roleSet.size !== roles.length) throw new Error('roles must contain every supported Agent Team role exactly once.');
const teamId = requiredString(raw.teamId, 'teamId', 240);
const data = await call('/agent-teams/' + encodeURIComponent(teamId), { method: 'PATCH', body: { roles } });
print({ worklite: { type: 'agent-team', id: data.id }, data });
`],
  ['scripts/start-agent-team-run.mjs', `#!/usr/bin/env node
import { authorizedCommands, call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['teamId', 'intent', 'projectDirectory', 'mode', 'authorizedCommands']);
const body = {
  intent: requiredString(raw.intent, 'intent', 100000),
  projectDirectory: requiredString(raw.projectDirectory, 'projectDirectory', 4096),
  mode: oneOf(raw.mode, 'mode', ['plan_only', 'validate_existing', 'implement_and_validate']),
};
const commands = authorizedCommands(raw.authorizedCommands);
if (commands !== undefined) body.authorizedCommands = commands;
const teamId = requiredString(raw.teamId, 'teamId', 240);
const result = await call('/agent-teams/' + encodeURIComponent(teamId) + '/runs', { method: 'POST', body });
print({ worklite: { type: 'agent-team-run', id: result.run.id }, data: result.run });
`],
  ['scripts/inspect-agent-team-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId']);
const runId = requiredString(raw.runId, 'runId', 240);
const data = await call('/agent-team-runs/' + encodeURIComponent(runId));
print({ worklite: { type: 'agent-team-run', id: data.id }, data });
`],
  ['scripts/answer-agent-team-run.mjs', `#!/usr/bin/env node
import { authorizedCommands, call, exactKeys, input, print, requiredString, text } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'pendingInputId', 'scopeRevision', 'answer', 'authorizedCommands']);
if (!Number.isInteger(raw.scopeRevision) || raw.scopeRevision < 1) throw new Error('scopeRevision must be a positive integer.');
const body = {
  pendingInputId: requiredString(raw.pendingInputId, 'pendingInputId', 240),
  scopeRevision: raw.scopeRevision,
  answer: text(raw.answer, 'answer', 100000),
};
const commands = authorizedCommands(raw.authorizedCommands);
if (commands !== undefined) body.authorizedCommands = commands;
const runId = requiredString(raw.runId, 'runId', 240);
const result = await call('/agent-team-runs/' + encodeURIComponent(runId) + '/answer', { method: 'POST', body });
print({ worklite: { type: 'agent-team-run-action', action: 'answer', runId: result.run.id }, data: result.run });
`],
  ['scripts/recover-agent-team-operation.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'operationKey', 'decision']);
const body = {
  operationKey: requiredString(raw.operationKey, 'operationKey', 1000),
  decision: oneOf(raw.decision, 'decision', ['adopt_command', 'mark_failed', 'replay']),
};
const runId = requiredString(raw.runId, 'runId', 240);
const path = '/agent-team-runs/' + encodeURIComponent(runId) + '/operations/' + encodeURIComponent(body.operationKey) + '/recovery';
const result = await call(path, { method: 'POST', body });
print({ worklite: { type: 'agent-team-run-action', action: 'recover', runId: result.run.id }, data: result.run });
`],
  ['scripts/control-agent-team-run.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print, requiredString } from './lib.mjs';
const raw = input();
exactKeys(raw, ['runId', 'action', 'taskKey']);
const runId = requiredString(raw.runId, 'runId', 240);
const action = oneOf(raw.action, 'action', ['pause', 'resume', 'cancel', 'retry']);
let path;
if (action === 'pause') path = '/agent-team-runs/' + encodeURIComponent(runId) + '/pause';
if (action === 'resume') path = '/agent-team-runs/' + encodeURIComponent(runId) + '/resume';
if (action === 'cancel') path = '/agent-team-runs/' + encodeURIComponent(runId) + '/cancel';
if (action === 'retry') {
  const taskKey = requiredString(raw.taskKey, 'taskKey', 240);
  path = '/agent-team-runs/' + encodeURIComponent(runId) + '/tasks/' + encodeURIComponent(taskKey) + '/retry';
}
const result = await call(path, { method: 'POST', body: {} });
print({ worklite: { type: 'agent-team-run-action', action, runId: result.run.id }, data: result.run });
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
import { call, exactKeys, input, oneOf, print } from './lib.mjs';
const raw = input();
exactKeys(raw, ['target']);
const target = oneOf(raw.target, 'target', ['home', 'skills', 'mcp-servers', 'model-providers', 'logs', 'workflows', 'settings-appearance', 'settings-usage', 'settings-audit-log']);
const action = await call('/navigation/resolve', { method: 'POST', body: { target } });
print({ worklite: action });
`],
  ['references/contracts.md', `# WorkLite platform script contracts

- inspect-workspace.mjs: no arguments
- inspect-workspace.mjs reports the active Gateway listener from the current profile; development defaults to port 3392 and local deployment defaults to port 23392.
- create-provider.mjs: { "name": string, "protocol": "openai/chat" | "openai/responses" | "anthropic/messages" | "codex/responses" | "typesafe/systemone", "baseURL": string, "models": string[] }. The protocol is required and is never selected automatically. System One model ids are entered manually because its upstream has no discovery endpoint.
- create-skill.mjs: { "name": string, "source": "online", "files": [{ "path": string, "content": string }] }
- create-mcp-server.mjs: { "name": string, "endpoint": string }
- create-workflow.mjs: { "name": string }. Creates a Workflow draft and returns its resource route.
- edit-workflow.mjs: { "workflowId": string, "sourceInstruction": string, "plan": WorkflowPlan }. Fetches the current draft revision and applies a server-normalized assistant plan. Timer and Dashboard configuration belongs in the Workflow graph, not in a standalone script. For TypeSafe calls, use \`typesafe/systemone@1\` with public \`config.model\`, immutable \`config.questions\`, and a required \`state\` input; do not include credentials, base URLs, or Provider ids. For editorial publishing, set JSON reviewer \`passthroughKeys\` to the original writer fields, keep the review response verdict-only, and connect its output through required \`worklite/approved-article@1.context\` before Article Artifact or WeChat. Apply collector \`maxToolCalls\`, \`maxToolRounds\`, and \`maxToolResultChars\` in its Agent config.

## Agent Team operation contract

- inspect-agent-teams.mjs: no arguments. Reads the one available built-in Team.
- inspect-agent-team.mjs: \`{ "teamId": string }\`.
- update-agent-team.mjs: \`{ "teamId": string, "roles": AgentTeamRoleConfiguration[] }\`. All six roles are required exactly once. Each role object has exactly \`role\`, \`publicModelId\`, \`instructions\`, \`entryPoints\`, \`skillIds\`, \`mcpServerIds\`, and \`toolNames\`; inspect the current Team and platform snapshot for supported values. An empty \`publicModelId\` allows the configured Team default.
- start-agent-team-run.mjs: \`{ "teamId": string, "intent": string, "projectDirectory": string, "mode": "plan_only" | "validate_existing" | "implement_and_validate", "authorizedCommands"?: string[] }\`. Commands are exact strings and \`plan_only\` cannot grant Commands.
- inspect-agent-team-run.mjs: \`{ "runId": string }\`. Inspect the Run before answering, recovering, controlling, or retrying it.
- answer-agent-team-run.mjs: \`{ "runId": string, "pendingInputId": string, "scopeRevision": positive integer, "answer": string, "authorizedCommands"?: string[] }\`. Only the structured command list changes executable authorization.
- recover-agent-team-operation.mjs: \`{ "runId": string, "operationKey": string, "decision": "adopt_command" | "mark_failed" | "replay" }\`. The operation key must identify the current uncertain operation.
- control-agent-team-run.mjs: \`{ "runId": string, "action": "pause" | "resume" | "cancel" | "retry", "taskKey"?: string }\`. \`taskKey\` is required only for \`retry\`, and retry is valid only for the failed active task the Run marks retryable.

Team creation and deletion are unavailable. A started Run captures an immutable TeamVersion. Skills and MCP servers referenced by active Team configuration or captured versions cannot be deleted. Run events are persisted and replay over the API's Server-Sent Event endpoint from \`Last-Event-ID\`; scripts inspect the persisted Run state rather than claiming to consume a live stream.

## Provider proxy capability contract

Provider configuration supports \`openai/chat\`, \`openai/responses\`, \`anthropic/messages\`, \`codex/responses\`, and \`typesafe/systemone\`. New Provider drafts require an explicit protocol; \`deepseek/chat\` is not a current selectable or runtime protocol. System One uses \`POST /api/portkey-gateway/v1/systemone\` with a typed \`state\` and \`questions\` body and returns typed \`answers\`; its model catalog is manual and it is not valid for Agent execution. Its dedicated Workflow node is \`typesafe/systemone@1\`, which uses the same transport with a public model id, immutable questions, and a connected JSON state input. Its connection test returns the typed input and output to the Providers dialog and carries a request-log id plus upstream reason on failure. The unified Gateway exposes \`POST /api/portkey-gateway/v1/messages\` for Claude Messages requests.

The unified image generation route is \`POST /api/portkey-gateway/v1/images/generations\`. It currently supports the automatic Codex Provider model \`codex/gpt-image-2\`. The body allowlist is \`prompt\`, \`model\`, \`n\`, \`background\`, \`quality\`, and \`size\`; unsupported standard Images fields are dropped before Codex transport. Successful responses carry generated PNG data in \`data[].b64_json\`. Image edits and binary Artifacts are unsupported. Workflow image generation uses \`worklite/image@1\`, which keeps generated PNG data internal to scheduler execution state and persists only image summaries in public payloads.

## Editorial article safety

A research Workflow reviewer should return only an approval decision and actionable feedback, not a copied article. On a JSON-mode Agent, \`passthroughKeys\` copies named writer input fields after parsing the model verdict; configure \`maxToolCalls\`, \`maxToolRounds\`, and \`maxToolResultChars\` on evidence collection to bound work and returned context. Route rejected drafts to at most one revision. Route every review result through \`worklite/approved-article@1\` before Article Artifact or WeChat; the node rejects missing approval, duplicates, and malformed Markdown rather than publishing after feedback exhaustion. Historical published versions and drafts remain unchanged.

The Workflow Plan contract also supports \`worklite/branch@1\`: connect a JSON-producing node to its required \`value\` input, then put predicate or fallback conditions on outgoing edges. The branch returns the original JSON and traverses only the first matching outgoing edge in plan order, with the first fallback as the no-match route. It also supports \`typesafe/systemone-map@1\` for per-element evaluation: connect a JSON-producing node to \`state\`, set \`itemsPath\` to the array inside that state, and read the committed \`results\` downstream. It also supports \`typesafe/systemone@1\`: connect a JSON-producing node to \`state\`, set \`model\` to a public TypeSafe Provider/model id, keep typed \`questions\` in the node config, and use paths such as \`$.answers.articleType.choice\` for downstream predicates while retaining object state fields for the next node.

## Workflow capability contract

Workflows never reference standalone Agent or AgentVersion records. Published Workflows may be invoked from workspace chat with an \`@Workflow\` mention; the remaining text is supplied as Workflow Input and the existing latest published WorkflowVersion Run endpoint is used. Draft Workflows are not runnable mentions. A Workflow Agent node is embedded and self-contained; its optional \`outputFormat\` selects \`text\` (default) or \`json\`, and JSON mode requires valid parseable final output. A JSON-mode node may also declare \`outputContract\`, a non-empty array of unique top-level key names its parsed object must carry; a parsed value that is not an object, or that omits a named key or carries it as \`null\`, an empty string, or an empty array, fails the node and names the missing keys. Without a contract any valid JSON is committed, so a node can succeed while returning a progress note instead of its intended result. A JSON-mode Agent can additionally use \`passthroughKeys\` to carry input fields without model rewriting; optional positive \`maxToolCalls\`, \`maxToolRounds\`, and \`maxToolResultChars\` bound tool use and returned context. Detailed Run responses include \`hasArtifactNode\`, ordered \`nodeRuns\`, and each node run's status, timing, retry count, failure text, and \`retryable\` flag. At most one node run of a failed Run is \`retryable\`, and \`POST /runs/:runId/nodes/:nodeRunId/retry\` re-enters exactly that node run. Run status can also be \`paused\`: \`POST /runs/:runId/pause\` accepts queued or running, \`POST /runs/:runId/resume\` accepts only paused, and resume reruns the active invocation without checkpointing it.

The platform Skill scripts/inspect-workspace.mjs reports current capability metadata; scripts/edit-workflow.mjs can connect worklite/approved-article@1 as a required context-input gate, and must not route a rejected review directly to Article Artifact or WeChat. The current capability contract is returned by inspect-workspace.mjs at \`capabilities.workflow.supportedNodeTypes\`. Each entry includes its public type, version, purpose, input and output ports, and configuration schema. Use only entries present in that snapshot, and set \`typeVersion: "2"\` when a plan needs a WeChat v2 node. An Artifact node requires a \`data\` input and owns a non-empty \`name\` plus \`text\`, \`markdown\`, or \`json\` type; a successful Run stores its Artifact and its node output is an Artifact reference. Multiple Artifact nodes are allowed. An Artifact Query node requires a \`request\` input, a JSON Artifact \`name\`, a \`titleField\`, and non-empty \`descriptionFields\`; it searches all matching workspace history, including detached Artifacts, skips records without a usable title and description, and returns the original request plus ordered candidate ids, titles, descriptions, and creation times without mutating Artifacts. Empty history returns an empty candidates array. A predicate on the duplicate-screening Agent output \`$.duplicate\` equal to \`false\` can gate downstream research; Agent semantic judgments are not guaranteed reproducible. An Approved Article node requires JSON on \`context\`, verifies explicit approval and Markdown structure, and returns the original article text; route only approved results to final Article Artifacts and WeChat. An Image node requires text on \`prompt\`, fixes the model to \`codex/gpt-image-2\`, and may send its generated PNG output only to WeChat v2 \`coverImage\`; public Run payloads expose image summaries rather than base64 data. The v1 WeChat node requires Markdown on \`article\`, accepts optional JSON \`metadata\`, and configures \`accountId\` plus \`draft\` or \`publish\` mode. The v2 WeChat node additionally requires generated cover JSON on \`coverImage\`. Human login and final publish confirmation suspend the Run as \`waiting_for_input\`; QR refresh continues the same Node Run, and WeChat nodes never create an Artifact. Draft mode resolves its draft id from the accepted save response or the editor URL's appmsgid parameter, reports a rejected save with WeChat's own status text, distinguishes an accepted save whose id is never exposed, and collects non-WeChat links from article input in the final Related Links section rather than rendering them as body links. Do not combine an enabled Timer with publish mode.

Use the approved-article node to gate editorial publication; a feedback loop must not bypass this node.

A WorkflowPlan has this shape (values are illustrative and must satisfy the current capability schemas):
\`\`\`json
{
  "nodes": [
    { "key": "timer", "type": "worklite/timer", "config": { "enabled": true, "intervalSeconds": 300 } },
    { "key": "agent", "type": "worklite/agent", "config": { "model": "provider/model", "systemPrompt": "Describe the task.", "outputFormat": "json", "skillIds": [], "mcpServerIds": [] } },
    { "key": "branch", "type": "worklite/branch", "config": {} },
    { "key": "rerank", "type": "typesafe/systemone-map", "config": { "model": "provider/model", "questions": {}, "itemsPath": "$.findings", "rank": { "path": "answers.relevance.noul", "order": "desc", "limit": 10 } } },
    { "key": "artifact", "type": "worklite/artifact", "config": { "name": "Result", "type": "json" } },
    { "key": "history", "type": "worklite/artifact-query", "config": { "name": "Research Notes", "titleField": "title", "descriptionFields": ["topic", "thesis"] } },
    { "key": "image", "type": "worklite/image", "config": { "model": "codex/gpt-image-2", "n": 1, "background": "opaque", "quality": "medium", "size": "1024x1024" } }
  ],
  "edges": [
    { "source": "timer", "target": "agent" },
    { "source": "agent", "target": "branch" },
    { "source": "branch", "target": "artifact", "condition": { "kind": "predicate", "path": "$.approved", "operator": "equals", "value": true } },
    { "source": "agent", "target": "image" }
  ],
  "input": {},
  "defaults": { "errorPolicy": "stop" }
}
\`\`\`
Node keys are local to the plan. Omit node ids and positions; the server generates both. Omit ports only when the capability has an unambiguous output or required input. The server validates node types, configuration, ports, workspace Skill/MCP references, structured edge conditions, and bounded-cycle constraints, then records an assistant revision.

Workflow Agent context is optional. An Agent context may receive one unbounded initial upstream edge plus one bounded feedback edge; a Workflow Input edge must be unconditional and unbounded. Without an unbounded incoming context edge, its initial invocation uses the Workflow input. Workflow graphs support unconditional, structured predicate, and fallback edges. Predicate edges use a dot-delimited output path and a declared comparison operator; fallback edges run only when no unconditional or predicate edge from the same node invocation matches. An edge may define a positive maxTraversals value, and every cycle must cross at least one such bounded edge. Dynamic joins, parallel execution, webhook triggers, API triggers, notification nodes, and template selection are unavailable unless the current snapshot reports them as supported. Use edit-workflow.mjs for Workflow graph creation and later edits; never write the database directly.

Scheduling is part of the immutable Workflow graph through the first-party \`worklite/timer\` node. Home board eligibility is part of the immutable graph through the first-party \`worklite/dashboard\` node: use at most one, connect its required \`data\` input, configure a layout of header, main, and footer element arrays (text, count, metric, and list kinds, where list elements own a \`titleKey\` matching their display-field keys), publish, and produce a successful Run. A Workflow has at most one Timer, the minimum interval is 300 seconds, Timer changes activate after Publish, and overlapping scheduled runs are prevented. There is no standalone schedule mutation script or API; \`GET /workflows/:workflowId/schedule\` exposes read-only runtime status. Home has no global Workflow data source; platform-defined Workflow boards are removed, and only a published Dashboard-node Workflow with a successful Dashboard output can be selected. Home category assignment is a database-backed organization reference with Uncategorized as the presentation default and at most one category per board; no Workflow output is persisted and no standalone category script is provided.

- update-settings.mjs: { "appearance"?: "system" | "light" | "dark" }
- navigate.mjs: { "target": "home" | "skills" | "mcp-servers" | "model-providers" | "logs" | "workflows" | "settings-appearance" | "settings-usage" | "settings-audit-log" }
`],
];

export function createDb(filePath: string) {
  const path = filePath === ':memory:' ? filePath : (isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath));
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const client = new BetterSqlite3(path);
  client.pragma('foreign_keys = ON');
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

export async function initializeDatabase(db: Database): Promise<void> {
  const migrationsFolder = [
    resolve(process.cwd(), 'packages/db/drizzle'),
    resolve(process.cwd(), '../../packages/db/drizzle'),
  ].find((candidate) => existsSync(candidate));
  if (!migrationsFolder) throw new Error('Drizzle migrations folder could not be located.');
  migrate(db, { migrationsFolder });

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

  const staleExecutions = db.$client.prepare(`
    SELECT id, workspace_id, agent_id,
      EXISTS (SELECT 1 FROM agent_sub_sessions WHERE agent_sub_sessions.execution_id = agent_executions.id) AS has_sub_session
    FROM agent_executions
    WHERE status = 'running'
  `).all() as Array<{ id: string; workspace_id: string; agent_id: string; has_sub_session: number }>;
  if (staleExecutions.length > 0) {
    db.$client.exec(`
      UPDATE agent_tool_calls
        SET status = 'failed', output = 'The API restarted before this Agent tool execution completed.', result_appended = 1, finished_at = unixepoch() * 1000
        WHERE status = 'running' AND execution_id IN (SELECT id FROM agent_executions WHERE status = 'running');
      UPDATE command_executions
        SET status = 'failed', signal = 'SIGHUP', finished_at = unixepoch() * 1000
        WHERE status IN ('queued', 'running', 'cancelling')
          AND id IN (SELECT command_execution_id FROM agent_tool_calls WHERE execution_id IN (SELECT id FROM agent_executions WHERE status = 'running'));
      UPDATE agent_executions
        SET status = 'failed', phase = 'recovery', error_code = 'restarted', error = 'The API restarted before this Agent turn completed.', updated_at = unixepoch() * 1000
        WHERE status = 'running';
      UPDATE agent_sub_sessions
        SET unread = 1, updated_at = unixepoch() * 1000
        WHERE execution_id IN (SELECT id FROM agent_executions WHERE error_code = 'restarted');
    `);
    for (const execution of staleExecutions) {
      db.insert(schema.auditLogs).values({
        id: `audit_${randomUUID()}`,
        workspaceId: execution.workspace_id,
        action: 'agent_execution.restarted',
        resource: execution.id,
        metadata: { agentId: execution.agent_id, executionId: execution.id, phase: 'recovery', errorCode: 'restarted', hasSubSession: Boolean(execution.has_sub_session) },
      }).run();
    }
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
    DELETE FROM agents WHERE id = 'agt_agent_chat';
    INSERT INTO workspaces (id, slug, name) VALUES ('workspace_personal', 'personal', 'Personal Workspace') ON CONFLICT (slug) DO NOTHING;
    INSERT INTO workspace_settings (workspace_id) SELECT id FROM workspaces WHERE slug = 'personal' ON CONFLICT (workspace_id) DO NOTHING;
    INSERT INTO model_providers (id, workspace_id, name, protocol, status, masked_key, models)
      SELECT 'gateway-provider', workspaces.id, 'WorkLite Gateway Provider', 'openai/chat', 'connected', '', '[]'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, protocol = excluded.protocol;
    INSERT INTO plugins (id, workspace_id, name, description, command)
      SELECT 'codex-cli-chat', workspaces.id, 'Codex CLI Chat', 'Chat with Codex CLI in the API workspace.', 'codex'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description;
    INSERT INTO plugins (id, workspace_id, name, description, command)
      SELECT 'wechat-official-account', workspaces.id, 'WeChat Official Account', 'Publish Workflow articles through a human-confirmed browser session.', 'node'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description;
    INSERT INTO wechat_official_accounts (id, workspace_id, display_name)
      SELECT 'wechat_official_account_personal', workspaces.id, 'Personal Official Account'
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, model)
      SELECT 'agt_system_helper_chat', workspaces.id, 'system', 'Chat Bot', 'Configure workspace AI resources through guided conversation', '${CHAT_BOT_PROMPT.replaceAll("'", "''")}', ''
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET kind = 'system', name = 'Chat Bot', responsibility = 'Configure workspace AI resources through guided conversation', system_prompt = excluded.system_prompt;
    INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, model)
      SELECT 'agt_codex_cli_chat', workspaces.id, 'system', 'Codex CLI Chat', 'Run conversations through the local Codex CLI', 'You are Codex CLI Chat. Answer the user request directly and concisely.', ''
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET kind = 'system', name = 'Codex CLI Chat', responsibility = 'Run conversations through the local Codex CLI', system_prompt = 'You are Codex CLI Chat. Answer the user request directly and concisely.';
  `);

  const upsertBuiltInSkill = db.$client.prepare(`
    INSERT INTO skills (id, workspace_id, name, source, version, validation, instructions)
      SELECT ?, workspaces.id, ?, 'built-in', 'built-in', 'valid', ?
      FROM workspaces WHERE workspaces.slug = 'personal'
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = 'built-in', version = 'built-in', validation = 'valid', instructions = excluded.instructions
  `);
  upsertBuiltInSkill.run('sk_terminal_command', 'terminal-command', TERMINAL_COMMAND_SKILL_MD);
  upsertBuiltInSkill.run('sk_worklite_platform', 'worklite-platform', WORKLITE_PLATFORM_SKILL_MD);
  db.$client.exec(`
    INSERT INTO skill_files (skill_id, path, content)
      SELECT id, 'SKILL.md', instructions FROM skills WHERE true
      ON CONFLICT (skill_id, path) DO NOTHING;
    DELETE FROM skill_files WHERE skill_id IN ('sk_terminal_command', 'sk_worklite_platform');
    DELETE FROM agent_skills WHERE skill_id = 'sk_worklite_platform' AND agent_id <> 'agt_system_helper_chat';
    INSERT INTO agent_skills (agent_id, skill_id) VALUES ('agt_system_helper_chat', 'sk_worklite_platform') ON CONFLICT (agent_id, skill_id) DO NOTHING;
  `);
  const upsertBuiltInFile = db.$client.prepare(`
    INSERT INTO skill_files (skill_id, path, content) VALUES (?, 'SKILL.md', ?)
    ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content
  `);
  upsertBuiltInFile.run('sk_terminal_command', TERMINAL_COMMAND_SKILL_MD);
  const upsertBuiltInScript = db.$client.prepare(`
    INSERT INTO skill_files (skill_id, path, content) VALUES (?, 'scripts/run.sh', ?)
    ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content
  `);
  upsertBuiltInScript.run('sk_terminal_command', TERMINAL_COMMAND_RUN_SH);
  const upsertPlatformFile = db.$client.prepare(`
    INSERT INTO skill_files (skill_id, path, content) VALUES ('sk_worklite_platform', ?, ?)
    ON CONFLICT (skill_id, path) DO UPDATE SET content = excluded.content
  `);
  for (const file of WORKLITE_PLATFORM_FILES) upsertPlatformFile.run(...file);
}
