#!/usr/bin/env node

// Every node in this graph renders as its bare type in the canvas, so five separate Agent nodes all
// read "Agent" and the editor cannot tell the planner from the reviewer. The editor already reads
// config.label for a node's display name; this fills it in for a graph that was assembled by script.
const baseUrl = process.env.WORKLITE_API_URL?.replace(/\/$/, '');
if (!baseUrl) throw new Error('Set WORKLITE_API_URL to the deployment API URL before naming the nodes.');

const workflowId = 'wf_d625cc98-dcdf-4305-98ec-11bca859eb46';

const labels = {
  input: '文章主题输入',
  topic: '选题规划',
  'collect-evidence': '资料检索与整合',
  'evidence-artifact': '研究笔记存档',
  write: '文章写作',
  review: '文章审校',
  article: '定稿放行',
  'article-artifact': '文章存档',
  'cover-prompt': '封面提示词',
  'cover-image': '封面生成',
  'wechat-publish': '公众号草稿',
};

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

const workflow = await request(`/workflows/${workflowId}`);
if (workflow.name !== 'GitHub Technology Trend Research' || !workflow.draft?.revisionId) {
  throw new Error('The target workflow or its draft revision is not available.');
}

const { nodes } = workflow.draft.definition;
const unknown = nodes.filter((node) => !(node.id in labels)).map((node) => node.id);
if (unknown.length > 0) throw new Error(`The graph contains nodes this script has no name for: ${unknown.join(', ')}.`);
const missing = Object.keys(labels).filter((id) => !nodes.some((node) => node.id === id));
if (missing.length > 0) throw new Error(`The graph no longer contains: ${missing.join(', ')}.`);

// A node whose label already differs was named by hand in the editor; overwriting it would discard
// the user's own wording.
const conflicting = nodes.filter((node) => {
  const current = node.config?.label;
  return typeof current === 'string' && current.trim() && current !== labels[node.id];
});
if (conflicting.length > 0) {
  throw new Error(`These nodes already carry a different name: ${conflicting.map((node) => `${node.id} (${node.config.label})`).join(', ')}.`);
}

const operations = nodes
  .filter((node) => node.config?.label !== labels[node.id])
  .map((node) => ({ type: 'updateNode', nodeId: node.id, patch: { config: { ...node.config, label: labels[node.id] } } }));

if (operations.length === 0) {
  process.stdout.write(JSON.stringify({ workflowId, unchanged: true }) + '\n');
  process.exit(0);
}

const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({
    baseRevisionId: workflow.draft.revisionId,
    operations,
    source: 'manual',
    sourceInstruction: 'Name every node so the editor shows what each step does instead of repeating its type.',
  }),
});
const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, named: operations.length, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
