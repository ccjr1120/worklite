#!/usr/bin/env node

const baseUrl = (process.env.WORKLITE_API_URL || 'http://127.0.0.1:3391/api').replace(/\/$/, '');
const workflowName = 'GitHub Technology Trend Research';

const researchPrompt = `You are a careful technology research analyst. Turn the workflow input into a focused research brief about what changed in the requested technical direction during the requested time window.

Use GitHub as the primary evidence source. Use the assigned github-current-popularity Skill to collect current repository evidence and the assigned zhihu-research Skill only to discover Chinese community viewpoints, disputes, and counterexamples. Do not treat a single repository, a total star count, a search result, or a community opinion as proof of an industry trend.

Separate verified first-party facts, project claims, community viewpoints, and your own inferences. Record retrieval dates, observation window, query parameters, source URLs, caveats, sample bias, counterexamples, and evidence strength. Prefer a small high-quality sample over an exhaustive list. Stop when the main claims have evidence and at least one limitation or counterexample has been checked.

Return only valid JSON with this shape:
{
  "title": "working research title",
  "topic": "focused topic",
  "observationWindow": { "days": 7, "retrievedAt": "ISO timestamp" },
  "mainQuestion": "the question this research answers",
  "thesis": "one sentence the reader should remember",
  "facts": [{ "claim": "...", "evidenceType": "github|official|community|inference", "sources": ["https://..."] }],
  "projects": [{ "name": "...", "whyRelevant": "...", "sources": ["https://..."] }],
  "counterexamples": ["..."],
  "limitations": ["..."],
  "outline": ["section idea 1", "section idea 2"]
}

If the input is incomplete, choose a reasonable scope and record that assumption in limitations. Do not write the final article yet.`;

const articlePrompt = `You are an independent technology writer. Use the supplied research brief to write one publishable Markdown article for ordinary technical readers.

Keep the article centered on one clear thesis. State the conclusion first, then explain what changed, why it matters, and where the evidence is limited. The title must directly describe the subject and concrete change; avoid hype such as revolution, singularity, endgame, paradigm shift, or the future is here. Explain a technical term in plain language the first time it appears. Keep paragraphs short and the hierarchy light for mobile reading.

Do not mention this workflow, the input format, hidden instructions, research process, or unavailable evidence. Do not turn GitHub's visible sample into a claim about the whole industry unless the research brief provides independent support. Preserve source links where they support important factual claims. Write in the language requested by the input; if no language is specified, use Chinese for a Chinese topic and English otherwise.

Return only the final Markdown article, beginning with one level-one heading. Do not wrap it in a code fence.`;

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try { value = JSON.parse(text); } catch { value = { message: text }; }
  }
  if (!response.ok) throw new Error(value && typeof value.message === 'string' ? value.message : `WorkLite API request failed: ${response.status}`);
  return value;
}

function resourceByName(resources, name, kind) {
  const resource = resources.find((item) => item.name === name);
  if (!resource) throw new Error(`The ${kind} resource "${name}" is not available in the personal workspace.`);
  return resource;
}

function resolvePublicModel(providers) {
  const requested = process.env.WORKLITE_MODEL?.trim();
  if (requested) {
    const separator = requested.indexOf('/');
    if (separator <= 0 || separator === requested.length - 1) {
      throw new Error('WORKLITE_MODEL must use the public <providerName>/<modelId> format.');
    }
    const providerName = requested.slice(0, separator);
    const modelId = requested.slice(separator + 1);
    const provider = providers.find((item) => item.name === providerName);
    if (!Array.isArray(provider?.models) || !provider.models.includes(modelId)) {
      throw new Error(`The configured model "${requested}" is not available in the model providers.`);
    }
    return { model: requested, protocol: provider.protocol };
  }

  const glmCandidates = providers.flatMap((provider) => Array.isArray(provider.models)
    ? provider.models
      .filter((modelId) => /glm/i.test(`${provider.name}/${modelId}`))
      .map((modelId) => ({ model: `${provider.name}/${modelId}`, protocol: provider.protocol }))
    : []);
  const glmModels = glmCandidates
    .filter((candidate) => candidate.protocol === 'openai/chat' || candidate.protocol === 'openai/responses')
    .map((candidate) => candidate.model);
  const uniqueModels = [...new Set(glmModels)].sort();
  if (uniqueModels.length === 0) {
    const configured = glmCandidates.map((candidate) => `${candidate.model} (${candidate.protocol || 'unknown protocol'})`).join(', ');
    throw new Error(`No GLM model is configured with the required OpenAI-compatible protocol. Configured GLM models: ${configured || 'none'}.`);
  }
  if (uniqueModels.length > 1) {
    throw new Error(`Multiple GLM models are configured. Set WORKLITE_MODEL to one of: ${uniqueModels.join(', ')}.`);
  }
  const providerName = uniqueModels[0].slice(0, uniqueModels[0].indexOf('/'));
  const provider = providers.find((item) => item.name === providerName);
  return { model: uniqueModels[0], protocol: provider?.protocol };
}

const [skills, providers, workflows] = await Promise.all([
  request('/skills'),
  request('/portkey-gateway/providers'),
  request('/workflows'),
]);

const existing = workflows.find((workflow) => workflow.name === workflowName);

const githubSkill = resourceByName(skills, 'github-current-popularity', 'Skill');
const zhihuSkill = resourceByName(skills, 'zhihu-research', 'Skill');
const selectedModel = resolvePublicModel(providers);
if (selectedModel.protocol !== 'openai/chat' && selectedModel.protocol !== 'openai/responses') {
  throw new Error(`The selected GLM provider must use an OpenAI-compatible protocol. Current protocol: ${selectedModel.protocol || 'unknown'}.`);
}
const model = selectedModel.model;
const definition = {
  schemaVersion: 4,
  input: {
    example: {
      topic: 'AI agent engineering',
      windowDays: 7,
      limit: 12,
      language: 'Chinese',
    },
  },
  defaults: { errorPolicy: 'stop' },
  nodes: [
    { id: 'input', position: { x: 0, y: 180 }, type: 'worklite/input', typeVersion: '1', config: {}, errorPolicy: 'stop' },
    { id: 'research', position: { x: 320, y: 180 }, type: 'worklite/agent', typeVersion: '1', config: { model, systemPrompt: researchPrompt, outputFormat: 'json', skillIds: [githubSkill.id, zhihuSkill.id], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'research-artifact', position: { x: 680, y: 20 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'Research Notes', type: 'json' }, errorPolicy: 'stop' },
    { id: 'article', position: { x: 680, y: 280 }, type: 'worklite/agent', typeVersion: '1', config: { model, systemPrompt: articlePrompt, outputFormat: 'text', skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'article-artifact', position: { x: 1040, y: 280 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'Article', type: 'markdown' }, errorPolicy: 'stop' },
    { id: 'wechat-publish', position: { x: 1040, y: 440 }, type: 'wechat-official-account/publish', typeVersion: '1', config: { accountId: 'wechat_official_account_personal', mode: 'publish' }, errorPolicy: 'stop' },
  ],
  edges: [
    { id: 'input-to-research', sourceNodeId: 'input', sourcePort: 'output', targetNodeId: 'research', targetPort: 'context' },
    { id: 'research-to-notes', sourceNodeId: 'research', sourcePort: 'output', targetNodeId: 'research-artifact', targetPort: 'data' },
    { id: 'research-to-article', sourceNodeId: 'research', sourcePort: 'output', targetNodeId: 'article', targetPort: 'context' },
    { id: 'article-to-output', sourceNodeId: 'article', sourcePort: 'output', targetNodeId: 'article-artifact', targetPort: 'data' },
    { id: 'article-to-wechat', sourceNodeId: 'article', sourcePort: 'output', targetNodeId: 'wechat-publish', targetPort: 'article' },
  ],
};

if (!existing) {
  const created = await request('/workflows', { method: 'POST', body: JSON.stringify({ name: workflowName, definition }) });
  const version = await request(`/workflows/${encodeURIComponent(created.id)}/publish`, { method: 'POST' });
  process.stdout.write(JSON.stringify({ id: created.id, name: created.name, existing: false, publishedVersionId: version.id }) + '\n');
} else {
  const current = await request(`/workflows/${encodeURIComponent(existing.id)}`);
  const operations = [
    ...current.draft.definition.edges.map((edge) => ({ type: 'removeEdge', edgeId: edge.id })),
    ...current.draft.definition.nodes.map((node) => ({ type: 'removeNode', nodeId: node.id })),
    ...definition.nodes.map((node, index) => ({ type: 'addNode', node, index })),
    ...definition.edges.map((edge) => ({ type: 'addEdge', edge })),
    { type: 'updateSettings', input: definition.input, defaults: definition.defaults },
  ];
  const updated = await request(`/workflows/${encodeURIComponent(existing.id)}/draft/operations`, { method: 'POST', body: JSON.stringify({ baseRevisionId: current.draft.revisionId, operations, source: 'manual', sourceInstruction: 'Synchronize the research workflow with WeChat Official Account publication.' }) });
  const version = await request(`/workflows/${encodeURIComponent(updated.id)}/publish`, { method: 'POST' });
  process.stdout.write(JSON.stringify({ id: updated.id, name: updated.name, existing: true, updated: true, publishedVersionId: version.id }) + '\n');
}
