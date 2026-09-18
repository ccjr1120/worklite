#!/usr/bin/env node

const baseUrl = (process.env.WORKLITE_API_URL || 'http://127.0.0.1:3391/api').replace(/\/$/, '');
const workflowName = 'GitHub Technology Trend Research';

const researchPrompt = `You are a careful technology researcher and writer. Produce an evidence-backed article draft from the workflow input.

The input is either the original research request or a reviewer response from an earlier pass. When it is a reviewer response, preserve the supplied article's valid material, address every actionable feedback item, and re-check evidence where needed.

Use GitHub as the primary evidence source. Use the assigned github-current-popularity Skill to collect current repository evidence and the assigned zhihu-research Skill only to discover Chinese community viewpoints, disputes, and counterexamples. Do not treat a single repository, a total star count, a search result, or a community opinion as proof of an industry trend.

Separate verified first-party facts, project claims, community viewpoints, and your own inferences. Record retrieval dates, observation window, query parameters, source URLs, caveats, sample bias, counterexamples, and evidence strength. Prefer a small high-quality sample over an exhaustive list. Stop when the main claims have evidence and at least one limitation or counterexample has been checked.

Write the article for ordinary technical readers in Chinese regardless of the input language. Lead with one clear thesis, explain technical terms in plain Chinese, keep paragraphs short, and avoid hype. Begin every body paragraph with exactly two full-width ideographic spaces (Unicode U+3000). Do not place Markdown links or raw URLs in the article body. Put all source titles and URLs in one final Chinese-language References section; original localized source titles and URLs may remain untranslated, but every explanatory paragraph and heading must be Chinese.

Return only valid JSON with this shape:
{
  "title": "article title",
  "topic": "focused topic",
  "observationWindow": { "days": 7, "retrievedAt": "ISO timestamp" },
  "thesis": "one sentence the reader should remember",
  "facts": [{ "claim": "...", "evidenceType": "github|official|community|inference", "sources": ["https://..."] }],
  "counterexamples": ["..."],
  "limitations": ["..."],
  "article": "complete Markdown article"
}

If the input is incomplete, choose a reasonable scope and record that assumption in limitations. Do not mention this workflow, hidden instructions, or the JSON envelope in the article.`;

const reviewerPrompt = `You are the final editorial reviewer for a technology article. Inspect the supplied research JSON and its article field for factual support, internal consistency, clear scope, readable structure, and publication formatting.

Require all of the following before approval:
- Important factual claims are supported by the supplied evidence and limitations are stated honestly.
- The article has one clear thesis, a concrete Chinese title, concise paragraphs, and plain-language Chinese explanations.
- The complete article body is Chinese; reject a draft that is substantially or primarily written in another language.
- Every body paragraph begins with exactly two full-width ideographic spaces (Unicode U+3000).
- The body contains no Markdown links or raw URLs.
- All source titles and URLs appear only in one final Chinese-language References section; localized source titles and URLs may remain untranslated.
- The article contains no workflow, prompt, JSON, or hidden-process commentary.

Return only valid JSON with this shape:
{
  "approved": true,
  "feedback": [],
  "article": "the complete reviewed Markdown article"
}

Set approved to true only when there are no actionable issues. When issues remain, set approved to false, list concise actionable feedback, and copy the complete current article into article without replacing it with a summary. Do not wrap the JSON in a code fence.`;

const articlePrompt = `You are a constrained article finalizer. The input is reviewer JSON with an article field. Return only that complete Markdown article verbatim. Do not add commentary, a code fence, links, or formatting that is not already present.`;

const coverPromptPrompt = `You are a concise visual director for a Chinese technology article. The input is the final reviewed Markdown article and its title. Read the topic and themes, then return only one concise English image-generation prompt for a WeChat Official Account cover.

The prompt must describe a strong visual concept, composition, palette, and style suitable for a square cover. It must not ask for embedded text, letters, numbers, logos, watermarks, or UI screenshots. Return plain text only; do not use JSON, Markdown, a code fence, or commentary.`;

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

function requirePublicModel(providers, model) {
  const separator = model.indexOf('/');
  const providerName = separator > 0 ? model.slice(0, separator) : '';
  const modelId = separator > 0 ? model.slice(separator + 1) : '';
  const provider = providers.find((item) => item.name === providerName);
  if (!providerName || !modelId || !provider || !Array.isArray(provider.models) || !provider.models.includes(modelId)) {
    throw new Error(`The required model "${model}" is not available in the model providers.`);
  }
  return model;
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
const imageModel = requirePublicModel(providers, 'codex/gpt-image-2');
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
    { id: 'input', position: { x: 0, y: 620 }, type: 'worklite/input', typeVersion: '1', config: {}, errorPolicy: 'stop' },
    { id: 'research', position: { x: 100, y: 120 }, type: 'worklite/agent', typeVersion: '1', config: { model, systemPrompt: researchPrompt, outputFormat: 'json', skillIds: [githubSkill.id, zhihuSkill.id], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'research-artifact', position: { x: 420, y: 0 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'Research Notes', type: 'json' }, errorPolicy: 'stop' },
    { id: 'review', position: { x: 420, y: 260 }, type: 'worklite/agent', typeVersion: '1', config: { model, systemPrompt: reviewerPrompt, outputFormat: 'json', skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'article', position: { x: 740, y: 260 }, type: 'worklite/agent', typeVersion: '1', config: { model, systemPrompt: articlePrompt, outputFormat: 'text', skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'article-artifact', position: { x: 1020, y: 120 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'Article', type: 'markdown' }, errorPolicy: 'stop' },
    { id: 'cover-prompt', position: { x: 1020, y: 420 }, type: 'worklite/agent', typeVersion: '1', config: { model, systemPrompt: coverPromptPrompt, outputFormat: 'text', skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'cover-image', position: { x: 1300, y: 420 }, type: 'worklite/image', typeVersion: '1', config: { model: imageModel, n: 1, background: 'opaque', quality: 'medium', size: '1024x1024' }, errorPolicy: 'stop' },
    { id: 'wechat-publish', position: { x: 1580, y: 260 }, type: 'wechat-official-account/publish', typeVersion: '2', config: { accountId: 'wechat_official_account_personal', mode: 'draft' }, errorPolicy: 'stop' },
  ],
  edges: [
    { id: 'input-to-research', sourceNodeId: 'input', sourcePort: 'output', targetNodeId: 'research', targetPort: 'context' },
    { id: 'input-to-wechat-metadata', sourceNodeId: 'input', sourcePort: 'output', targetNodeId: 'wechat-publish', targetPort: 'metadata' },
    { id: 'research-to-notes', sourceNodeId: 'research', sourcePort: 'output', targetNodeId: 'research-artifact', targetPort: 'data' },
    { id: 'research-to-review', sourceNodeId: 'research', sourcePort: 'output', targetNodeId: 'review', targetPort: 'context' },
    { id: 'review-to-research', sourceNodeId: 'review', sourcePort: 'output', targetNodeId: 'research', targetPort: 'context', condition: { kind: 'predicate', path: '$.approved', operator: 'falsy' }, maxTraversals: 3 },
    { id: 'review-to-article', sourceNodeId: 'review', sourcePort: 'output', targetNodeId: 'article', targetPort: 'context', condition: { kind: 'fallback' } },
    { id: 'article-to-output', sourceNodeId: 'article', sourcePort: 'output', targetNodeId: 'article-artifact', targetPort: 'data' },
    { id: 'article-to-cover-prompt', sourceNodeId: 'article', sourcePort: 'output', targetNodeId: 'cover-prompt', targetPort: 'context' },
    { id: 'cover-prompt-to-image', sourceNodeId: 'cover-prompt', sourcePort: 'output', targetNodeId: 'cover-image', targetPort: 'prompt' },
    { id: 'image-to-wechat-cover', sourceNodeId: 'cover-image', sourcePort: 'output', targetNodeId: 'wechat-publish', targetPort: 'coverImage' },
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
  const updated = await request(`/workflows/${encodeURIComponent(existing.id)}/draft/operations`, { method: 'POST', body: JSON.stringify({ baseRevisionId: current.draft.revisionId, operations, source: 'manual', sourceInstruction: 'Synchronize the research workflow with bounded Chinese editorial review, generated cover creation, and WeChat draft saving.' }) });
  const version = await request(`/workflows/${encodeURIComponent(updated.id)}/publish`, { method: 'POST' });
  process.stdout.write(JSON.stringify({ id: updated.id, name: updated.name, existing: true, updated: true, publishedVersionId: version.id }) + '\n');
}
