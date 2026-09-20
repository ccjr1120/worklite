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

const SYSTEM_HELPER_PROMPT = `You are Chat Bot, the WorkLite workspace assistant.
Use only assigned Skill scripts for platform inspection and operations. For product capability questions, rely on the assigned Skill knowledge and the current workspace snapshot. Never invent configured resources, models, MCP tools, script results, or platform capabilities.
The development profile uses Web port 3390, API port 3391, and Portkey Gateway port 3392. The local deployment profile uses Web port 23390, API port 23391, and Portkey Gateway port 23392. Do not suggest compatibility listeners for previous development ports.
Model Provider drafts require an explicit protocol selection. Supported protocols are \`openai/chat\`, \`openai/responses\`, \`anthropic/messages\`, and \`codex/responses\`; do not invent or default another protocol. Existing \`deepseek/chat\` records are not migrated or aliased.
The unified Provider proxy supports Codex image generation at \`/api/portkey-gateway/v1/images/generations\` with the public model \`codex/gpt-image-2\`; it returns base64 image JSON and does not support image edits. Workflows can use the first-party \`worklite/image@1\` node instead: it requires \`prompt\`, fixes the model to \`codex/gpt-image-2\`, retains generated PNG data only in scheduler execution state, and exposes image summaries in public logs, results, and events. Image output may connect only to the WeChat v2 \`coverImage\` input.
For Workflow requests, call scripts/inspect-workspace.mjs first. Choose only node capabilities returned in capabilities.workflow.supportedNodeTypes and only workspace resource ids returned in the snapshot. Organize graph changes as a logical Workflow Plan with stable human-readable node keys; do not invent durable node ids or canvas positions. Use scripts/edit-workflow.mjs to apply the plan to a draft. Scheduling is represented by one first-party worklite/timer node in the Workflow graph: configure its enabled and intervalSeconds fields, then publish the Workflow. A Workflow has at most one Timer, the minimum interval is 300 seconds, and there is no standalone schedule script. Existing wechat-official-account/publish@1 nodes accept Markdown plus optional metadata and remain runnable. New v2 nodes additionally require coverImage from worklite/image@1; both versions can save a draft or publish it. Draft mode succeeds once WeChat accepts the save and exposes a draft id in either the save response or the editor URL's appmsgid parameter; a rejected save reports WeChat's own status text, an accepted save with no exposed id reports that distinct condition, and non-WeChat article links are presented in the final Related Links section rather than as body links. Login and final publication confirmation create durable pending actions: the Run and current Node Run wait for a human QR scan, survive API restarts, and resume the same node without rerunning successful predecessors. A retried WeChat node reopens an existing draft rather than creating a second one. An enabled Timer cannot be combined with publish mode. Home boards are represented by one first-party worklite/dashboard node with a compositional layout of header, main, and footer element arrays; elements are text, count, metric, or list, and list elements own a titleKey plus display fields. Configure its data input and publish the Workflow, then run it successfully. Dashboard output uses the board format: an object or object array whose records back list elements, with row titles from each list element's titleKey and board titles from the Workflow name. Home has no global Workflow data source. A first-party \`worklite/artifact-query@1\` node reads all matching workspace JSON Artifact history, including detached Artifacts. Connect its required \`request\` input, configure \`name\`, \`titleField\`, and non-empty \`descriptionFields\`; it passes the request through with matching Artifact ids, titles, descriptions, and creation times. Empty history returns an empty candidates array without creating or changing Artifacts. A Workflow Agent can compare these candidates with a proposed title and description; only a predicate on an explicit \`duplicate\` boolean should advance article production. Semantic decisions by the Agent are not deterministic, even though retrieval and routing are. Workflow Agent nodes expose only text or parsed JSON and never create Artifacts. Persist Artifact output only with the first-party worklite/artifact node: connect required data, configure name and text/markdown/json type; successful execution stores the Artifact and emits its reference, and multiple Artifact nodes are allowed. Workflow Run records expose ordered node execution logs and credential-safe failure reasons; Artifact presentation is omitted when the immutable Workflow version has no Artifact node. A failed Run can be retried from the one node run the server marks retryable, which re-enters the same node without rerunning successful predecessors; retrying an earlier successful node is not supported. Published Workflows can be selected with an \`@Workflow\` mention in workspace chat; the remaining text becomes Workflow Input, execution creates a normal version-bound Run, and Draft Workflows are not runnable mentions. Eligible boards start in the presentation-only Uncategorized group, and users can store at most one database-backed category assignment per board in the API database; organization metadata never stores Workflow output. The server owns normalization, ids, layout, port and configuration validation, workspace resource validation, structured edge-condition validation, bounded-cycle validation, and assistant revision history.
Never ask the user to paste API keys, tokens, passwords, or other secrets into conversation or script arguments. Provider credentials must be entered in the dedicated secure form.
Before claiming a platform operation completed, wait for the script result. Keep responses concise and practical.`;

const WORKLITE_PLATFORM_SKILL_MD = `# worklite-platform

Use the exact scripts in this package for WorkLite platform operations.

Use \`scripts/inspect-workspace.mjs\` before answering questions about configured resources or Workflow capabilities. Creation, settings, and navigation scripts accept exactly one JSON object argument. Every valid Agent script call executes automatically after server validation. Provider scripts never accept credentials; direct the user to the secure Provider form after creation.

The development profile uses Web port \`3390\`, API port \`3391\`, and Portkey Gateway port \`3392\`. The local deployment profile remains on Web port \`23390\`, API port \`23391\`, and Portkey Gateway port \`23392\`. Previous development ports have no compatibility listeners or redirects.
Model Provider drafts require an explicit protocol selection. Supported protocols are \`openai/chat\`, \`openai/responses\`, \`anthropic/messages\`, and \`codex/responses\`; do not invent or default another protocol. Existing \`deepseek/chat\` records are not migrated or aliased.

The unified Provider proxy supports Codex image generation at \`/api/portkey-gateway/v1/images/generations\`. The automatic Codex Provider advertises \`codex/gpt-image-2\`; the operation forwards only \`prompt\`, \`model\`, \`n\`, \`background\`, \`quality\`, and \`size\` and returns generated images as \`data[].b64_json\`. It does not support image edits, and no standalone platform script is provided for image generation.

The first-party Workflow node \`worklite/image@1\` wraps that capability. Its required \`prompt\` input accepts text, its model is fixed to \`codex/gpt-image-2\`, and its generated PNG remains internal to Run execution state. Public Run results, node logs, and events contain only an image summary; image output may connect only to \`wechat-official-account/publish@2.coverImage\`. Image edits and binary Artifacts remain unsupported.

Workflow automation and Home are WorkLite's primary product services. Workflows are the only user-configurable execution capability; Chat Bot is the protected workspace entry for guided operations. A Workflow never selects or references a standalone Agent or Agent version; its Agent nodes own their configuration inside immutable Workflow versions. Home has no global Workflow data source. A Workflow appears on Home only when its latest published version contains its one \`worklite/dashboard\` node, and its selected board reads that node's object or object-array output from the latest successful Run of that version. Boards render the Dashboard layout's header, main, and footer elements; list elements define row titles through \`titleKey\` and their display fields, and board titles use the Workflow name. Eligible boards default to Uncategorized; users can move each board into at most one database-backed category, and those records only organize references. Platform-defined Workflow boards are removed. Workflow scheduling is represented by one first-party \`worklite/timer\` node. The first-party node types are Input, Timer, Agent, Dashboard, Artifact, Artifact Query, and Image. The Image node is \`worklite/image@1\`: it requires a text prompt, fixes the model to \`codex/gpt-image-2\`, returns generated PNG data only inside scheduler execution state, and public Run payloads expose summaries. Its output may connect only to WeChat v2 \`coverImage\`. The built-in \`wechat-official-account/publish\` node has immutable v1 versions that accept Markdown article and optional metadata, while v2 additionally requires a generated \`coverImage\`. Both versions save drafts or publish through a product-owned Playwright browser session. Draft mode succeeds once WeChat accepts the save and exposes a draft id in either the save response or the editor URL's appmsgid parameter; a rejected save reports WeChat's own status text, an accepted save with no exposed id reports that distinct condition, and non-WeChat article links are rendered in the final Related Links section rather than as body links. Login and final confirmation are durable pending actions with QR-only client payloads; completed predecessors are not rerun on resume, and a retried node reopens an existing draft instead of creating a second one. Enabled Timer nodes may use draft mode but cannot use publish mode. Workflow Agent nodes own prompts and Skill/MCP selections; their \`context\` input is optional and may combine one unbounded initial upstream edge with one bounded feedback edge; a Workflow Input edge remains unconditional and unbounded. Artifact nodes own Artifact creation, and Agent and WeChat nodes never create Artifacts.

Workflow node capabilities are dynamic. Always use the current snapshot's \`capabilities.workflow.supportedNodeTypes\` list, including each type, version, purpose, ports, and configuration schema. Do not assume a node exists when it is absent from the snapshot. A logical plan uses model-chosen node keys and edges between those keys; the server generates durable ids and positions.

Published Workflows are executable from workspace chat through \`@Workflow\` mentions. The remaining message text is the Workflow Input, execution uses the latest immutable published version, and Run progress and Artifacts appear in the chat transcript. Draft Workflows are excluded. This chat dispatcher does not turn Workflows into Agents or create Agent sessions.

Workflow List is the user-facing access point for per-Workflow Run history. Expanded Run rows expose ordered node execution logs with failure reasons, and a failed Run offers a retry control on the single node entry the server marks retryable. They expose Artifacts inline only when the immutable Workflow version contains an Artifact node, and an individual Artifact detail is directly addressable without a standalone Artifact collection destination.

Workflow Agent context is optional. An Agent context may receive one unbounded initial upstream edge plus one bounded feedback edge; a Workflow Input edge must be unconditional and unbounded. Without an unbounded incoming context edge, its initial invocation uses the Workflow input. Workflow graphs support unconditional, structured predicate, and fallback edges. Predicate edges use a dot-delimited output path and a declared comparison operator; fallback edges run only when no unconditional or predicate edge from the same node invocation matches. An edge may define a positive maxTraversals value, and every cycle must cross at least one such bounded edge. Dynamic joins, parallel execution, webhook triggers, API triggers, notification nodes, and template selection are unavailable unless the current snapshot reports them as supported.

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
const body = { name: requiredString(raw.name, 'name', 120), protocol: oneOf(raw.protocol, 'protocol', ['openai/chat', 'openai/responses', 'anthropic/messages', 'codex/responses']), baseURL: requiredString(raw.baseURL, 'baseURL', 2048), models: stringArray(raw.models, 'models', 100, 200) };
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
  ['scripts/update-settings.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print } from './lib.mjs';
const raw = input();
exactKeys(raw, ['appearance', 'locale']);
const body = {};
if ('appearance' in raw) body.appearance = oneOf(raw.appearance, 'appearance', ['system', 'light', 'dark']);
if ('locale' in raw) body.locale = oneOf(raw.locale, 'locale', ['en', 'zh-CN']);
if (Object.keys(body).length === 0) throw new Error('At least one setting is required.');
const settings = await call('/settings', { method: 'PATCH', body });
print({ worklite: { type: 'settings', appearance: settings.appearance, locale: settings.locale }, data: settings });
`],
  ['scripts/navigate.mjs', `#!/usr/bin/env node
import { call, exactKeys, input, oneOf, print } from './lib.mjs';
const raw = input();
exactKeys(raw, ['target']);
const target = oneOf(raw.target, 'target', ['home', 'system-helper-chat', 'skills', 'mcp-servers', 'model-providers', 'workflows', 'settings-appearance', 'settings-usage', 'settings-audit-log']);
const action = await call('/navigation/resolve', { method: 'POST', body: { target } });
print({ worklite: action });
`],
  ['references/contracts.md', `# WorkLite platform script contracts

- inspect-workspace.mjs: no arguments
- inspect-workspace.mjs reports the active Gateway listener from the current profile; development defaults to port 3392 and local deployment defaults to port 23392.
- create-provider.mjs: { "name": string, "protocol": "openai/chat" | "openai/responses" | "anthropic/messages" | "codex/responses", "baseURL": string, "models": string[] }. The protocol is required and is never selected automatically.
- create-skill.mjs: { "name": string, "source": "online", "files": [{ "path": string, "content": string }] }
- create-mcp-server.mjs: { "name": string, "endpoint": string }
- create-workflow.mjs: { "name": string }. Creates a Workflow draft and returns its resource route.
- edit-workflow.mjs: { "workflowId": string, "sourceInstruction": string, "plan": WorkflowPlan }. Fetches the current draft revision and applies a server-normalized assistant plan. Timer and Dashboard configuration belongs in the Workflow graph, not in a standalone script.

## Provider proxy capability contract

Provider configuration supports \`openai/chat\`, \`openai/responses\`, \`anthropic/messages\`, and \`codex/responses\`. New Provider drafts require an explicit protocol; \`deepseek/chat\` is not a current selectable or runtime protocol. The unified Gateway exposes \`POST /api/portkey-gateway/v1/messages\` for Claude Messages requests.

The unified image generation route is \`POST /api/portkey-gateway/v1/images/generations\`. It currently supports the automatic Codex Provider model \`codex/gpt-image-2\`. The body allowlist is \`prompt\`, \`model\`, \`n\`, \`background\`, \`quality\`, and \`size\`; unsupported standard Images fields are dropped before Codex transport. Successful responses carry generated PNG data in \`data[].b64_json\`. Image edits and binary Artifacts are unsupported. Workflow image generation uses \`worklite/image@1\`, which keeps generated PNG data internal to scheduler execution state and persists only image summaries in public payloads.

## Workflow capability contract

Workflows never reference standalone Agent or AgentVersion records. Published Workflows may be invoked from workspace chat with an \`@Workflow\` mention; the remaining text is supplied as Workflow Input and the existing latest published WorkflowVersion Run endpoint is used. Draft Workflows are not runnable mentions. A Workflow Agent node is embedded and self-contained; its optional \`outputFormat\` selects \`text\` (default) or \`json\`, and JSON mode requires valid parseable final output. Detailed Run responses include \`hasArtifactNode\`, ordered \`nodeRuns\`, and each node run's status, timing, retry count, failure text, and \`retryable\` flag. At most one node run of a failed Run is \`retryable\`, and \`POST /runs/:runId/nodes/:nodeRunId/retry\` re-enters exactly that node run.

The current capability contract is returned by inspect-workspace.mjs at \`capabilities.workflow.supportedNodeTypes\`. Each entry includes its public type, version, purpose, input and output ports, and configuration schema. Use only entries present in that snapshot, and set \`typeVersion: "2"\` when a plan needs a WeChat v2 node. An Artifact node requires a \`data\` input and owns a non-empty \`name\` plus \`text\`, \`markdown\`, or \`json\` type; a successful Run stores its Artifact and its node output is an Artifact reference. Multiple Artifact nodes are allowed. An Artifact Query node requires a \`request\` input, a JSON Artifact \`name\`, a \`titleField\`, and non-empty \`descriptionFields\`; it searches all matching workspace history, including detached Artifacts, skips records without a usable title and description, and returns the original request plus ordered candidate ids, titles, descriptions, and creation times without mutating Artifacts. Empty history returns an empty candidates array. A predicate on the duplicate-screening Agent output \`$.duplicate\` equal to \`false\` can gate downstream research; Agent semantic judgments are not guaranteed reproducible. An Image node requires text on \`prompt\`, fixes the model to \`codex/gpt-image-2\`, and may send its generated PNG output only to WeChat v2 \`coverImage\`; public Run payloads expose image summaries rather than base64 data. The v1 WeChat node requires Markdown on \`article\`, accepts optional JSON \`metadata\`, and configures \`accountId\` plus \`draft\` or \`publish\` mode. The v2 WeChat node additionally requires generated cover JSON on \`coverImage\`. Human login and final publish confirmation suspend the Run as \`waiting_for_input\`; QR refresh continues the same Node Run, and WeChat nodes never create an Artifact. Draft mode resolves its draft id from the accepted save response or the editor URL's appmsgid parameter, reports a rejected save with WeChat's own status text, distinguishes an accepted save whose id is never exposed, and collects non-WeChat links from article input in the final Related Links section rather than rendering them as body links. Do not combine an enabled Timer with publish mode.

A WorkflowPlan has this shape (values are illustrative and must satisfy the current capability schemas):
\`\`\`json
{
  "nodes": [
    { "key": "timer", "type": "worklite/timer", "config": { "enabled": true, "intervalSeconds": 300 } },
    { "key": "agent", "type": "worklite/agent", "config": { "model": "provider/model", "systemPrompt": "Describe the task.", "outputFormat": "json", "skillIds": [], "mcpServerIds": [] } },
    { "key": "artifact", "type": "worklite/artifact", "config": { "name": "Result", "type": "json" } },
    { "key": "history", "type": "worklite/artifact-query", "config": { "name": "Research Notes", "titleField": "title", "descriptionFields": ["topic", "thesis"] } },
    { "key": "image", "type": "worklite/image", "config": { "model": "codex/gpt-image-2", "n": 1, "background": "opaque", "quality": "medium", "size": "1024x1024" } }
  ],
  "edges": [
    { "source": "timer", "target": "agent" },
    { "source": "agent", "target": "artifact", "condition": { "kind": "predicate", "path": "$.approved", "operator": "equals", "value": true } },
    { "source": "agent", "target": "image" }
  ],
  "input": {},
  "defaults": { "errorPolicy": "stop" }
}
\`\`\`
Node keys are local to the plan. Omit node ids and positions; the server generates both. Omit ports only when the capability has an unambiguous output or required input. The server validates node types, configuration, ports, workspace Skill/MCP references, structured edge conditions, and bounded-cycle constraints, then records an assistant revision.

Workflow Agent context is optional. An Agent context may receive one unbounded initial upstream edge plus one bounded feedback edge; a Workflow Input edge must be unconditional and unbounded. Without an unbounded incoming context edge, its initial invocation uses the Workflow input. Workflow graphs support unconditional, structured predicate, and fallback edges. Predicate edges use a dot-delimited output path and a declared comparison operator; fallback edges run only when no unconditional or predicate edge from the same node invocation matches. An edge may define a positive maxTraversals value, and every cycle must cross at least one such bounded edge. Dynamic joins, parallel execution, webhook triggers, API triggers, notification nodes, and template selection are unavailable unless the current snapshot reports them as supported. Use edit-workflow.mjs for Workflow graph creation and later edits; never write the database directly.

Scheduling is part of the immutable Workflow graph through the first-party \`worklite/timer\` node. Home board eligibility is part of the immutable graph through the first-party \`worklite/dashboard\` node: use at most one, connect its required \`data\` input, configure a layout of header, main, and footer element arrays (text, count, metric, and list kinds, where list elements own a \`titleKey\` matching their display-field keys), publish, and produce a successful Run. A Workflow has at most one Timer, the minimum interval is 300 seconds, Timer changes activate after Publish, and overlapping scheduled runs are prevented. There is no standalone schedule mutation script or API; \`GET /workflows/:workflowId/schedule\` exposes read-only runtime status. Home has no global Workflow data source; platform-defined Workflow boards are removed, and only a published Dashboard-node Workflow with a successful Dashboard output can be selected. Home category assignment is a database-backed organization reference with Uncategorized as the presentation default and at most one category per board; no Workflow output is persisted and no standalone category script is provided.

- update-settings.mjs: { "appearance"?: "system" | "light" | "dark", "locale"?: "en" | "zh-CN" }
- navigate.mjs: { "target": "home" | "system-helper-chat" | "skills" | "mcp-servers" | "model-providers" | "workflows" | "settings-appearance" | "settings-usage" | "settings-audit-log" }
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
      SELECT 'agt_system_helper_chat', workspaces.id, 'system', 'Chat Bot', 'Configure workspace AI resources through guided conversation', '${SYSTEM_HELPER_PROMPT.replaceAll("'", "''")}', ''
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
