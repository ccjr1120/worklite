#!/usr/bin/env node

// Run only after the deployment API has been replaced with the runtime that supports the approval gate.
const baseUrl = process.env.WORKLITE_API_URL?.replace(/\/$/, '');
if (!baseUrl) throw new Error('Set WORKLITE_API_URL to the deployment API URL before updating the workflow.');

const workflowId = 'wf_d625cc98-dcdf-4305-98ec-11bca859eb46';

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}) },
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`WorkLite API request failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

const [workflow, snapshot, providers] = await Promise.all([
  request(`/workflows/${workflowId}`),
  request('/platform/snapshot'),
  request('/portkey-gateway/providers'),
]);

const capabilities = snapshot.capabilities?.workflow?.supportedNodeTypes ?? [];
const gate = capabilities.find((node) => node.type === 'worklite/approved-article' && node.version === '1');
const agent = capabilities.find((node) => node.type === 'worklite/agent');
if (!gate || !agent?.configSchema?.properties?.passthroughKeys || !agent.configSchema.properties.maxToolCalls) {
  throw new Error('The deployment API does not yet support the approved-article gate and bounded Agent tools. Replace the runtime before publishing this graph.');
}

if (workflow.name !== 'GitHub Technology Trend Research' || !workflow.draft?.revisionId) {
  throw new Error('The target workflow or its draft revision is not available.');
}
const { nodes, edges } = workflow.draft.definition;
const nodeById = (id) => {
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Expected workflow node ${id} is missing.`);
  return node;
};
for (const id of ['collect-official', 'collect-community', 'write', 'review', 'article', 'article-artifact', 'wechat-publish']) nodeById(id);
if (nodeById('article').type !== 'worklite/agent' || nodeById('review').type !== 'worklite/agent') {
  throw new Error('The target graph has changed; do not overwrite a newer article or review node.');
}
const feedbackEdge = edges.find((edge) => edge.id === 'review-to-write');
const publicationEdge = edges.find((edge) => edge.id === 'review-to-article');
if (feedbackEdge?.maxTraversals !== 3 || publicationEdge?.condition?.kind !== 'fallback') {
  throw new Error('The target review loop has changed; inspect its edges before editing.');
}

for (const node of nodes) {
  const model = node.config?.model;
  if (model === undefined) continue;
  const [providerName, ...parts] = model.split('/');
  const modelId = parts.join('/');
  const provider = providers.find((item) => item.name === providerName);
  if (!modelId || !provider?.models?.includes(modelId)) throw new Error(`Deployment model ${model} on node ${node.id} is unavailable.`);
}

const writer = nodeById('write');
const reviewer = nodeById('review');
const collector = nodeById('collect-community');
const reviewerMarker = 'Return only valid JSON with this shape:';
if (!reviewer.config.systemPrompt.includes(reviewerMarker) || !reviewer.config.systemPrompt.includes('report every defect you find, with no cap on the number.')) {
  throw new Error('The deployed reviewer prompt has changed; do not edit it by text substitution.');
}
const reviewPrompt = reviewer.config.systemPrompt
  .slice(0, reviewer.config.systemPrompt.indexOf(reviewerMarker))
  .replace('report every defect you find, with no cap on the number.', 'report at most three concrete, severity-ordered defects.')
  + `Return only valid JSON with these fields:
{
  "approved": true,
  "duplicate": false,
  "feedback": [],
  "round": 1,
  "resolved": [],
  "open": []
}

This graph has no historical candidate list. Set duplicate to false only when no duplicate is identifiable from the supplied draft; do not claim to have screened article history. Set approved to true only when open and feedback are both empty. When rejecting, return at most three specific defects in open as objects with id and note; return the same objects in feedback. Preserve resolved entries from the input. On a later pass, check only whether the prior open defects were fixed. Check that all multi-line code examples are in correctly closed fenced Markdown code blocks with a language label, and that ordinary body paragraphs remain outside those fences. Do not return the article, title, evidence, or any other writer fields: the runtime carries them through unchanged. Do not wrap JSON in a code fence.`;

const operations = [
  { type: 'updateNode', nodeId: collector.id, patch: { config: {
    ...collector.config,
    maxToolCalls: 7,
    maxToolRounds: 5,
    maxToolResultChars: 16000,
    systemPrompt: collector.config.systemPrompt + '\n\nFinish with the evidence already collected when the tool budget ends. Never repeat a search to use up the allowance; record missing coverage as a gap.',
  } } },
  { type: 'updateNode', nodeId: writer.id, patch: { config: {
    ...writer.config,
    systemPrompt: writer.config.systemPrompt + '\n\nWhen the evidence package contains a callable usage example, place the complete multi-line example in a standalone, language-labeled fenced Markdown code block. Put opening and closing fences on their own lines and leave a blank line around the block. Do not indent code fences as body paragraphs. Preserve existing valid code blocks during revision; never turn executable code into inline prose.',
  } } },
  { type: 'updateNode', nodeId: reviewer.id, patch: { config: {
    ...reviewer.config,
    systemPrompt: reviewPrompt,
    outputContract: ['approved', 'duplicate'],
    passthroughKeys: ['title', 'topic', 'readerQuestions', 'evidenceUsed', 'article'],
  } } },
  { type: 'updateNode', nodeId: 'article', patch: { type: 'worklite/approved-article', typeVersion: '1', config: {} } },
  { type: 'removeEdge', edgeId: feedbackEdge.id },
  { type: 'addEdge', edge: { ...feedbackEdge, maxTraversals: 1 } },
];

const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({ baseRevisionId: workflow.draft.revisionId, operations, source: 'manual', sourceInstruction: 'Bound community retrieval and editorial feedback, preserve writer Markdown, and require approval before WeChat draft creation.' }),
});
const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
