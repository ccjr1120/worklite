#!/usr/bin/env node

const baseUrl = (process.env.WORKLITE_API_URL || 'http://127.0.0.1:3391/api').replace(/\/$/, '');
const workflowName = 'GitHub Technology Trend Research';

const titleRules = `Title rules. The title must be one concrete Chinese sentence stating a specific finding or judgement that a reader understands without the article. It must name at least one concrete anchor: a project, an organization, a mechanism, or a number.

Reject every one of these title shapes:
- A quoted metaphor or a colon followed by a subtitle.
- A trailing survey label such as an observation, a snapshot, a review, a study, a panorama, a decoding, or a window of N days.
- The words 观察, 思考, 浅析, 深度解析, 全景, 启示, 范式, 重塑, 赋能, 揭秘, 复盘, 洞察, or 图景.
- A rhetorical question, an ellipsis, an exclamation mark, or a superlative.

Keep the title within 26 Chinese characters.`;

const proseRules = `Writing rules for the article body. Write for a working engineer who reads on a phone and stops at the first paragraph that sounds machine-generated.

- Open with the finding or a concrete fact. Do not open with background, scope framing, or a statement about what the article will do.
- Never refer to the article or yourself. Do not write 本文, 笔者, 我们认为, 综上所述, 值得注意的是, 需要指出的是, 首先/其次/最后, or 可以说.
- Do not turn the research fields into section headings. There must be no section named after a conclusion summary, a method or sampling statement, a counterexample list, a limitation list, or an inference. State a caveat or a sampling limit in one or two sentences inside the paragraph that depends on it, and state it once in the whole article.
- Use three to five section headings. Each heading is a short informative phrase carrying real content, not a label.
- Vary sentence and paragraph length. Place at least one short sentence under fifteen characters in the article. Do not let every paragraph run to the same size.
- Interpret numbers instead of listing them. Give at most two or three data points in one paragraph, and say what each one means for the reader. Do not enumerate repositories with their star counts in sequence.
- Carry uncertainty in the claim itself, not in a disclaimer after it. Write 仓库自述说它降低了开销 rather than asserting the reduction and then adding that this comes from the project's own description. Never end a paragraph with a sentence whose only job is to qualify the paragraph above it.
- Name the retrieval window once, in plain Chinese, where search evidence first appears, so a reader can judge a window-dependent claim. Do not repeat it and do not give it its own section.
- Keep at least one paragraph under 120 characters and every paragraph under 250. Keep sentences under 60 characters, and use at most one parenthetical aside per paragraph.
- Let the sections build on each other rather than partition the subject into parallel categories. Reject an outline whose sections could be reordered without loss.
- No emoji, no decorative bold, and none of 闭环, 抓手, 生态位, 护城河, 赛道, 范式转移, 降维打击.
- Keep the references section to the sources the body actually uses, at most ten entries.`;

const publicationRules = `Publication format. Begin the article with exactly one level-one Markdown heading ("# ") holding the article title, matching the title field, appearing exactly once. Use level-two or deeper headings for every section inside the body. Begin every body paragraph with exactly two full-width ideographic spaces (Unicode U+3000). Place no Markdown links and no raw URLs in the body. Put all source titles and URLs in one final Chinese-language References section; localized source titles and URLs may stay untranslated, but every explanatory paragraph and heading must be Chinese.`;

const topicPrompt = `You plan one focused technology article from the workflow input. Propose a specific title and short description for the article before any research or writing. Do not write the article, cite sources, or claim that current evidence has already been verified.

${titleRules}

The description states the narrow question the article answers and the judgement it expects to reach, in two sentences at most.

Return only valid JSON with this shape:
{
  "request": { "original": "the complete original workflow input, preserving its value and structure" },
  "proposal": { "title": "proposed article title", "description": "brief scope and central idea" }
}

Preserve the complete workflow input in request.original as its original JSON value, whether text or an object, including any structure or constraints; do not replace it with a summary. Do not wrap the JSON in a code fence.`;

const collectPrompt = `You are a technology research collector. You gather and select evidence. You do not write the article, and no part of your output is published.

The input is an Artifact Query result containing request and candidates. The planning output is nested one level deeper: the original instruction is at request.request.original and the approved proposal is at request.proposal, holding title and description. Treat request.proposal as the assigned subject and collect evidence for it. Do not substitute a subject you find more interesting. Copy the candidates array verbatim into your output.

Tool calls and model tool rounds are bounded by the Workflow runtime. Prioritize distinct, high-value queries; if a source fails or reports exhausted quota, do not repeat it. Conclude with gathered evidence and explicitly identify gaps.

- Issue several distinct queries in a single turn when you already know what to ask. Batching is much cheaper than asking one at a time.
- A repeat of a query you already issued returns the stored earlier result with a repeatedCall note. It is free of the allowance but yields nothing new, so treat it as a signal to move on rather than to search again.
- When a call returns argumentNotes, your arguments were corrected; reissuing will not improve the result.

Stop on evidence, not on the allowance. You have enough when you hold mechanism evidence for at least three projects or sources, at least one genuine dispute or tradeoff, and at least one contrast between two approaches. Stop there even with queries left. If quotaExhausted arrives, retrieval is over: write your evidence output immediately and record what is missing in gaps. A thin evidence set is recoverable; looping until the node runs out of turns fails the Workflow and discards everything you gathered.

The GitHub Skill returns two layers. Search listings give the landscape. The studiedRepositories entries carry README prose, in-window commit subjects, release notes, and the most-discussed issues and pull requests, and they are the only layer that supports a real claim. A repository description is a self-applied label: it says what a project wants to be called, never how it works, what it changed, or whether its users agree. Evidence built from descriptions and star counts produces an article that says nothing, which is the failure this node exists to prevent.

Select rather than forward. For each project you keep, extract three to five findings that a reader would find worth knowing, each quoting or closely paraphrasing its source passage. Prefer, in this order: a concrete mechanism and what it costs; a change made inside the window; a dispute, defect, or unresolved tradeoff from discussion; two projects solving one problem differently. Drop a finding you cannot attribute to a README passage, commit subject, release note, or discussion thread. Three well-sourced findings beat ten thin ones, and you must not pad the list.

Separate what is verified, what a project claims about itself, what the community says, and what you infer. Name what you could not establish in gaps; the writer will treat a gap as unavailable rather than guessing.

Return only valid JSON with this shape:
{
  "title": "the assigned proposal title, copied from request.proposal.title",
  "topic": "the assigned subject, restated in one sentence",
  "thesis": "the single judgement your collected evidence supports, in one sentence",
  "observationWindow": { "days": 7, "windowStart": "YYYY-MM-DD", "retrievedAt": "ISO timestamp" },
  "queries": ["each search term you actually used"],
  "findings": [{
    "projectOrSource": "repository full name, organization, or publication",
    "finding": "what a reader would find worth knowing, stated concretely",
    "evidenceType": "readme|commit|release|discussion|official|community|inference",
    "sourceQuote": "the passage, commit subject, or thread title behind it",
    "url": "https://..."
  }],
  "contrasts": [{ "question": "the shared problem", "positions": ["project A's approach and its cost", "project B's approach and its cost"] }],
  "disputes": [{ "what": "the disagreement, defect, or unresolved tradeoff", "source": "thread title or community source", "url": "https://..." }],
  "gaps": ["what you could not establish, and why"],
  "candidates": [{ "artifactId": "...", "title": "...", "description": "...", "createdAt": "ISO timestamp or null" }]
}

The title, topic, and thesis fields are required: this output is persisted as the Research Notes Artifact, and later Runs screen new proposals for duplication against exactly those three fields. Omitting them makes this Run invisible to that check.

Do not write article prose and do not wrap the JSON in a code fence.`;

const writePrompt = `You are a Chinese technology writer. You write one article from an evidence package that is already collected. You have no research tools, and you must not invent a fact that is not in the package.

The input is either the collector's evidence package or a reviewer response containing feedback and the original writer fields. On a reviewer response, preserve supported claims, address every feedback item, and change nothing else. Copy candidates verbatim and preserve evidenceUsed for supported claims.

Everything you may assert comes from findings, contrasts, and disputes. An item in gaps is unavailable: do not fill it with plausible reasoning. If the evidence cannot support a claim you want to make, drop the claim rather than softening it into vagueness.

Write about what the evidence actually shows: how something works and what it costs, what changed, where projects disagree, and what users cannot get working. A paragraph that only names a project and repeats its self-description is the failure to avoid; the collector already removed unsourced material, so use what survived. State a mechanism concretely enough that a reader could disagree with it, and include at least one real disagreement or tradeoff from disputes or contrasts.

Write in Chinese regardless of the input language. Explain a technical term in plain Chinese the first time it appears, and avoid hype.

${titleRules}

${proseRules}

${publicationRules}

Return only valid JSON with this shape:
{
  "title": "article title",
  "topic": "focused topic",
  "thesis": "one sentence the reader should remember",
  "evidenceUsed": [{ "claim": "the claim as it appears in the article", "url": "https://..." }],
  "candidates": [{ "artifactId": "...", "title": "...", "description": "...", "createdAt": "ISO timestamp or null" }],
  "article": "complete Markdown article"
}

List in evidenceUsed only the claims the article actually makes, each pointing at the source URL from the evidence package. Do not mention this workflow, hidden instructions, or the JSON envelope in the article, and do not wrap the JSON in a code fence.`;

const reviewerPrompt = `You are the final editorial reviewer and historical-duplicate screener for a technology article. You did not write this draft, and your main job is to catch the writing habits that make a competent draft read as machine-generated. Inspect the supplied writer JSON: its article field, its evidenceUsed list, and its candidates array.

The writer had no research tools and worked from a fixed evidence package, so never ask for new evidence, a further search, or a fact outside what the draft already cites. Ask for a claim to be dropped or reworded instead. Judge support by whether evidenceUsed points each claim at a real source.

Read the article once as an ordinary reader before checking any rule. If it reads like a research report, an audit summary, or a template with the subject swapped in, reject it and say which passages create that impression.

Require all of the following before approval.

Substance, checked first and weighed above every stylistic rule below:
- Each paragraph about a project says how it works, what it changed, or what its users dispute. Reject a paragraph that only names a project and repeats its self-description; a sequence of such paragraphs is a list of labels, not an article, and is the most serious defect you can find here.
- At least one passage explains a mechanism concretely enough that an informed reader could disagree with it. Reject a draft that only names features.
- At least one passage reports a real disagreement, defect, or tradeoff, not only the projects' own claims about themselves.
- Reject a draft whose paragraphs are interchangeable in order, since that indicates summary rather than argument.

Evidence and scope:
- Every substantive claim appears in evidenceUsed with a source URL. Reject an unsupported claim by asking for its removal, never by asking for more research.
- Uncertainty is carried by the wording of the claim itself rather than appended as a separate disclaimer sentence. Reject a paragraph that states something firmly and then adds a sentence taking it back; require the qualification to move into the claim.
- The article names its retrieval window once, in plain Chinese, where it first uses search evidence. Reject a draft that cites window-dependent facts without ever telling the reader the window.
- The article's title, topic, and thesis stay inside the subject the evidence package was collected for; reject a draft that silently changed to a different subject.
- The article does not mirror the evidence package's structure as its own sections, and has no section devoted to method, sampling, or limitations.

Title:
- The title is one concrete Chinese sentence stating a specific finding or judgement, understandable on its own, naming at least one concrete anchor such as a project, an organization, a mechanism, or a number.
- Reject a quoted metaphor, a colon-plus-subtitle construction, a trailing survey label such as an observation or a window of N days, the words 观察, 思考, 浅析, 深度解析, 全景, 启示, 范式, 重塑, 赋能, 揭秘, 复盘, 洞察, or 图景, a rhetorical question, an ellipsis, an exclamation mark, or a superlative.
- Reject a title longer than 26 Chinese characters.

Prose:
- The opening states the finding or a concrete fact, not background or a statement of what the article will do.
- No self-reference: reject 本文, 笔者, 我们认为, 综上所述, 值得注意的是, 需要指出的是, 首先/其次/最后 as a sequence, or 可以说.
- Three to five section headings, each an informative phrase rather than a label.
- Sentence and paragraph length varies: at least one sentence under fifteen characters, at least one paragraph under 120 characters, no paragraph over 250, no sentence over 60, and at most one parenthetical aside per paragraph.
- Numbers are interpreted rather than enumerated: at most two or three data points in a paragraph, and no sequential listing of repositories with star counts.
- Sections build on each other; reject an outline whose sections are parallel categories that could be reordered without loss.
- No emoji, no decorative bold, and none of 闭环, 抓手, 生态位, 护城河, 赛道, 范式转移, 降维打击.
- The references section lists only sources the body uses, at most ten entries.

Publication format:
- The complete article body is Chinese; reject a draft substantially or primarily written in another language.
- The article begins with exactly one level-one Markdown heading ("# ") that holds the article title and matches the title field, and every section heading inside the body is level two or deeper.
- Every body paragraph begins with exactly two full-width ideographic spaces (Unicode U+3000).
- The body contains no Markdown links or raw URLs.
- All source titles and URLs appear only in one final Chinese-language References section; localized source titles and URLs may remain untranslated.
- The article contains no workflow, prompt, JSON, or hidden-process commentary.

Duplicates:
- The current title, topic, thesis, and article substance do not substantially repeat a historical candidate. A duplicate means the core subject and central thesis overlap, not merely that two articles belong to the same broad technology area. Historical candidates may be intermediate drafts; evaluate them as potential prior work.

Return only valid JSON with this shape:
{
  "approved": true,
  "duplicate": false,
  "matchedArtifactIds": [],
  "feedback": []
}

Set approved to true only if no actionable quality issue remains and duplicate is false. For a duplicate, identify the matched artifact and give concise feedback requesting a materially different topic or thesis. Return at most three specific, severity-ordered feedback items naming the passage and exact change. Never reproduce the article or evidence in the response: the runtime preserves the writer's original fields. Do not wrap the JSON in a code fence.`;

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

const AGENT_PROTOCOLS = new Set(['openai/chat', 'openai/responses', 'anthropic/messages']);

// Each Agent role names its own candidates in preference order. Planning and cover direction take a
// fast model, research and writing take the strongest verified writing model, and review takes a
// different provider family so it does not share the writing model's stylistic habits.
const roleModels = {
  planning: { env: 'WORKLITE_PLANNING_MODEL', candidates: ['GLM/glm-5.3-flash', 'GLM/glm-5.3'] },
  writing: { env: 'WORKLITE_WRITING_MODEL', candidates: ['GLM/glm-5.3'] },
  review: { env: 'WORKLITE_REVIEW_MODEL', candidates: ['pp-api/gpt-5.6-sol', 'pp-api/gpt-6-astra', 'GLM/glm-5.3'] },
};

function findPublicModel(providers, model) {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return null;
  const providerName = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const provider = providers.find((item) => item.name === providerName);
  if (!provider || !Array.isArray(provider.models) || !provider.models.includes(modelId)) return null;
  return { model, protocol: provider.protocol, providerName };
}

function resolveRoleModel(providers, role) {
  const { env, candidates } = roleModels[role];
  const requested = process.env[env]?.trim();
  if (requested) {
    const resolved = findPublicModel(providers, requested);
    if (!resolved) throw new Error(`${env} model "${requested}" is not available in the model providers.`);
    if (!AGENT_PROTOCOLS.has(resolved.protocol)) throw new Error(`${env} model "${requested}" uses protocol ${resolved.protocol || 'unknown'}, which Agent nodes do not support.`);
    return resolved;
  }
  for (const candidate of candidates) {
    const resolved = findPublicModel(providers, candidate);
    if (resolved && AGENT_PROTOCOLS.has(resolved.protocol)) return resolved;
  }
  throw new Error(`No ${role} model is available. Configure one of ${candidates.join(', ')} with a supported model protocol, or set ${env}.`);
}

const [skills, providers, workflows] = await Promise.all([
  request('/skills'),
  request('/portkey-gateway/providers'),
  request('/workflows'),
]);

const existing = workflows.find((workflow) => workflow.name === workflowName);

const githubSkill = resourceByName(skills, 'github-current-popularity', 'Skill');
const zhihuSkill = resourceByName(skills, 'zhihu-research', 'Skill');
const planningModel = resolveRoleModel(providers, 'planning').model;
const writingModel = resolveRoleModel(providers, 'writing').model;
const reviewModel = resolveRoleModel(providers, 'review').model;
// The cross-family review provider is less reliable than the writing provider, so this one node
// retries in run instead of failing the article on a transient upstream error.
const reviewErrorPolicy = reviewModel === writingModel ? 'stop' : 'retry';
const imageModel = requirePublicModel(providers, 'codex/gpt-image-2');
const models = { planning: planningModel, writing: writingModel, review: reviewModel, reviewErrorPolicy, image: imageModel };
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
    { id: 'topic', position: { x: 260, y: 620 }, type: 'worklite/agent', typeVersion: '1', config: { model: planningModel, systemPrompt: topicPrompt, outputFormat: 'json', skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'history', position: { x: 540, y: 620 }, type: 'worklite/artifact-query', typeVersion: '1', config: { name: 'Research Notes', titleField: 'title', descriptionFields: ['topic', 'thesis'] }, errorPolicy: 'stop' },
    { id: 'collect', position: { x: 820, y: 620 }, type: 'worklite/agent', typeVersion: '1', config: { model: writingModel, systemPrompt: collectPrompt, outputFormat: 'json', outputContract: ['title', 'topic', 'thesis', 'findings', 'candidates'], maxToolCalls: 7, maxToolRounds: 5, maxToolResultChars: 16000, skillIds: [githubSkill.id, zhihuSkill.id], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'evidence-artifact', position: { x: 1100, y: 620 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'Research Notes', type: 'json' }, errorPolicy: 'stop' },
    { id: 'write', position: { x: 100, y: 120 }, type: 'worklite/agent', typeVersion: '1', config: { model: writingModel, systemPrompt: writePrompt, outputFormat: 'json', outputContract: ['title', 'topic', 'thesis', 'article'], skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'review', position: { x: 420, y: 260 }, type: 'worklite/agent', typeVersion: '1', config: { model: reviewModel, systemPrompt: reviewerPrompt, outputFormat: 'json', outputContract: ['approved', 'duplicate'], passthroughKeys: ['title', 'topic', 'thesis', 'evidenceUsed', 'candidates', 'article'], skillIds: [], mcpServerIds: [] }, errorPolicy: reviewErrorPolicy },
    { id: 'article', position: { x: 740, y: 260 }, type: 'worklite/approved-article', typeVersion: '1', config: {}, errorPolicy: 'stop' },
    { id: 'article-artifact', position: { x: 1020, y: 120 }, type: 'worklite/artifact', typeVersion: '1', config: { name: 'Article', type: 'markdown' }, errorPolicy: 'stop' },
    { id: 'cover-prompt', position: { x: 1020, y: 420 }, type: 'worklite/agent', typeVersion: '1', config: { model: planningModel, systemPrompt: coverPromptPrompt, outputFormat: 'text', skillIds: [], mcpServerIds: [] }, errorPolicy: 'stop' },
    { id: 'cover-image', position: { x: 1300, y: 420 }, type: 'worklite/image', typeVersion: '1', config: { model: imageModel, n: 1, background: 'opaque', quality: 'medium', size: '1024x1024' }, errorPolicy: 'stop' },
    { id: 'wechat-publish', position: { x: 1580, y: 260 }, type: 'wechat-official-account/publish', typeVersion: '2', config: { accountId: 'wechat_official_account_personal', mode: 'draft' }, errorPolicy: 'stop' },
  ],
  edges: [
    { id: 'input-to-topic', sourceNodeId: 'input', sourcePort: 'output', targetNodeId: 'topic', targetPort: 'context' },
    { id: 'topic-to-history', sourceNodeId: 'topic', sourcePort: 'output', targetNodeId: 'history', targetPort: 'request' },
    { id: 'history-to-collect', sourceNodeId: 'history', sourcePort: 'output', targetNodeId: 'collect', targetPort: 'context' },
    { id: 'collect-to-evidence', sourceNodeId: 'collect', sourcePort: 'output', targetNodeId: 'evidence-artifact', targetPort: 'data' },
    { id: 'collect-to-write', sourceNodeId: 'collect', sourcePort: 'output', targetNodeId: 'write', targetPort: 'context' },
    { id: 'input-to-wechat-metadata', sourceNodeId: 'input', sourcePort: 'output', targetNodeId: 'wechat-publish', targetPort: 'metadata' },
    { id: 'write-to-review', sourceNodeId: 'write', sourcePort: 'output', targetNodeId: 'review', targetPort: 'context' },
    { id: 'review-to-write', sourceNodeId: 'review', sourcePort: 'output', targetNodeId: 'write', targetPort: 'context', condition: { kind: 'predicate', path: '$.approved', operator: 'falsy' }, maxTraversals: 1 },
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
  process.stdout.write(JSON.stringify({ id: created.id, name: created.name, existing: false, publishedVersionId: version.id, models }) + '\n');
} else {
  const current = await request(`/workflows/${encodeURIComponent(existing.id)}`);
  const operations = [
    ...current.draft.definition.edges.map((edge) => ({ type: 'removeEdge', edgeId: edge.id })),
    ...current.draft.definition.nodes.map((node) => ({ type: 'removeNode', nodeId: node.id })),
    ...definition.nodes.map((node, index) => ({ type: 'addNode', node, index })),
    ...definition.edges.map((edge) => ({ type: 'addEdge', edge })),
    { type: 'updateSettings', input: definition.input, defaults: definition.defaults },
  ];
  const updated = await request(`/workflows/${encodeURIComponent(existing.id)}/draft/operations`, { method: 'POST', body: JSON.stringify({ baseRevisionId: current.draft.revisionId, operations, source: 'manual', sourceInstruction: 'Keep writer Markdown unchanged, bound collection and revision, and block unapproved articles before draft creation.' }) });
  const version = await request(`/workflows/${encodeURIComponent(updated.id)}/publish`, { method: 'POST' });
  process.stdout.write(JSON.stringify({ id: updated.id, name: updated.name, existing: true, updated: true, publishedVersionId: version.id, models }) + '\n');
}
