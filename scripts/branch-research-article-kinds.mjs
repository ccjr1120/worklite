#!/usr/bin/env node

// Splits the research workflow on the kind of article being written. A survey request ("what is
// trending") and an explanatory request ("what is X") need different retrieval shapes and different
// article structures, but they share review, approval, archiving, cover art, and publication, so the
// branches reconverge instead of duplicating the whole chain.
const baseUrl = process.env.WORKLITE_API_URL?.replace(/\/$/, '');
if (!baseUrl) throw new Error('Set WORKLITE_API_URL to the deployment API URL before branching the workflow.');

const workflowId = 'wf_d625cc98-dcdf-4305-98ec-11bca859eb46';
const githubSkillId = 'sk_029f68e6-1b9e-4a65-a230-be02a78e5521';
const zhihuSkillId = 'sk_fa6143da-e62d-4a16-bbf8-bd8df148dba2';
const docsSkillId = 'sk_ea37cc32-6f30-47d1-a120-2ebef9321d30';

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

const { nodes, edges } = workflow.draft.definition;
const nodeById = (id) => {
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Expected workflow node ${id} is missing.`);
  return node;
};
const edgeById = (id) => {
  const edge = edges.find((item) => item.id === id);
  if (!edge) throw new Error(`Expected workflow edge ${id} is missing.`);
  return edge;
};

const planner = nodeById('topic');
const collector = nodeById('collect-evidence');
const writer = nodeById('write');
const reviewer = nodeById('review');
for (const id of ['topic-to-evidence', 'evidence-to-notes', 'evidence-to-write', 'write-to-review', 'review-to-write', 'review-to-article']) edgeById(id);
if (nodes.some((node) => node.id === 'survey-evidence')) throw new Error('The survey branch already exists; this migration has run.');

const model = collector.config.model;
const plannerModel = planner.config.model;
const feedbackEdge = edgeById('review-to-write');
if (feedbackEdge.maxTraversals !== 1) throw new Error('The editorial feedback edge is no longer bounded at one traversal.');

// The planner used to assume every request named one technology, so "what is trending on GitHub" was
// planned as an explanatory article and its reader questions pulled the whole run down into one
// project's installation notes. It now classifies the request first and the graph routes on that.
const plannerKindRules = `Before writing the questions, decide which kind of article the input asks for and record it in proposal.articleKind.

"survey" is a request to see a field: what is trending, what is new lately, which projects are getting attention, what is worth watching in some area. The reader wants the spread and does not yet care how any single thing is installed.

"explainer" is a request about one subject: what X is, how it works, how it is used, whether to adopt or migrate to it. This is the default, and an input naming one technology is always an explainer.

The kind decides the questions, so get it right before writing them. A survey's questions ask which things are drawing attention, what those things have in common, and how a reader should read the ranking; they never ask what prerequisites one project has, what its risks are, or how to call it, because a question about one project's setup turns a survey into an explainer about whichever project the retrieval happened to read. An explainer's questions follow the existing order: what it is, how it differs, how it is used, when to avoid it.

Good reader questions for a survey:
- 最近受关注的项目集中在哪些方向
- 这些项目为什么在同一时间获得关注
- 热度数字能说明什么，不能说明什么

`;

const plannerShapeFrom = `  "proposal": {
    "title": "proposed article title",
    "description": "what the article explains and for whom",
    "readerQuestions": ["each reader question, in plain Chinese, in reading order"]
  }`;
const plannerShapeTo = `  "proposal": {
    "articleKind": "survey or explainer",
    "title": "proposed article title",
    "description": "what the article explains and for whom",
    "readerQuestions": ["each reader question, in plain Chinese, in reading order"]
  }`;

const plannerAnchor = 'Write three to five reader questions.';
if (!planner.config.systemPrompt.includes(plannerAnchor)) throw new Error('The deployed planner prompt has changed; do not edit it by text substitution.');
if (!planner.config.systemPrompt.includes(plannerShapeFrom)) throw new Error('The deployed planner output shape has changed.');
const plannerPrompt = planner.config.systemPrompt
  .replace(plannerAnchor, plannerKindRules + plannerAnchor)
  .replace(plannerShapeFrom, plannerShapeTo);

// A fixed allowance per Skill made every question spend the same effort everywhere, so a GitHub
// question still burnt queries on Zhihu and a Chinese-practice question still crawled repositories.
// The budget now follows the subject, and an irrelevant source is meant to go uncalled.
const retrievalStrategy = `Choose where the evidence actually lives before you search, and spend your effort there.

Read the request and the reader questions, then name the primary source to yourself.
- GitHub is primary when the subject is a repository, an implementation, a defect, a comparison of open-source projects, or activity across projects.
- Zhihu is primary when the subject is how Chinese teams adopt, operate, or argue about something, or when the question is about practice rather than code.
- Documentation is primary when the subject is a product with published docs and the question is what it does or how it is called.

Give the primary source up to four distinct queries. Give a secondary source one or two, and only for the side the primary cannot show: GitHub cannot tell you how a team felt operating something, and Zhihu cannot establish what a repository's code does. A source with nothing to contribute to this subject gets no call at all, and calling it anyway to use up an allowance is wasted retrieval, not thoroughness.

Call each Skill in its own form. The GitHub Skill takes the query first: research.mjs "<query>" 7 12 4. The Zhihu Skill takes a subcommand first: zhihu.sh search "<query>" 5. Passing a query to the Zhihu Skill without the search subcommand fails and spends the call for nothing.

Documentation is read, not found. Pass official-docs-fetch only addresses that retrieval already returned: a link in a README, a release note, or a source link under a search result. Never infer a hostname from a subject's name, never append a path you have not seen, and never try a domain to learn whether it exists. If no documentation address surfaced, do not call that Skill, and do not record its absence as a gap.

Stop when the reader questions are covered, even with allowance left. Every result stays in your context, and once the window fills the engine silently drops your earliest messages, so evidence you gathered first disappears and you will believe you never gathered it. Write the quotes you need into your output as you go. Each Skill reports when a query or URL was already served: that notice means you already hold the material, so move on rather than rephrasing the same request.`;

const evidenceLabelling = `Label every finding with what it is, and keep the voices separate. A claim from a subject's own documentation is that vendor describing itself; mark it official and attribute it. An outside measurement or a working reimplementation is independent and carries more weight. A practitioner account is community. Your own reasoning is inference and is not a source. A number the vendor published and a blogger repeated is still the vendor's number.

What you retrieved is verified material. An endpoint, an authentication header, a request body, a field name, a type value, or a code sample that appears in something you fetched must be copied into your output exactly as it was given, including its letter case. Never report retrieved content as unavailable: the material is in your context whether or not it looks complete to you.

A repository description states what a project claims to be. Draw mechanism from README text, real progress from commit subjects and release notes, and disagreement from issue and pull request discussion.

Record in gaps what retrieval could not establish, naming the Skill that refused if one did. gaps is for absent content, not for material you chose not to trust.`;

const findingsShape = `  "findings": [{
    "question": "the reader question this serves, copied",
    "point": "what a reader should learn here, stated concretely",
    "sourceType": "official|independent|community|inference",
    "sourceQuote": "the passage, commit subject, or thread title behind it",
    "url": "https://..."
  }],`;

const surveyEvidencePrompt = `You gather the evidence for one survey article about what is currently drawing attention in a field. You do not write the article, and no part of your output is published.

The input is the planning output: the original instruction is at request.original, and the approved proposal is at proposal, holding articleKind, title, description, and readerQuestions. Those reader questions are your assignment.

Your job is breadth. Find ten projects that are actually getting attention right now and record each one, rather than reading one project deeply. A survey that covers three projects in detail has failed at the thing it was asked to do.

${retrievalStrategy}

For each project record its name, its repository or source URL, one plain sentence saying what it is, and the direction it belongs to. Give a heat number only where retrieval actually returned one, and say in the same entry what that number is: a weekly-ranking star count from a community list is not the same measurement as a repository's total stars, and neither is a star gain inside a window. The GitHub Skill returns accumulated totals, not gains, so never present a total as recent growth. When a community ranking supplies the figure, name that ranking as its source; do not launder it into a GitHub statistic.

Do not descend into one project's setup, prerequisites, authentication, or error handling. That material belongs to an explanatory article, and collecting it here produces a survey that is secretly about whichever project you happened to read.

${evidenceLabelling}

Return only valid JSON with this shape:
{
  "title": "the assigned proposal title, copied from proposal.title",
  "articleKind": "survey",
  "topic": "the field this article surveys, in one sentence",
  "readerQuestions": ["copied from proposal.readerQuestions, in order"],
  "projects": [{
    "name": "owner/repo or the project's own name",
    "url": "https://...",
    "what": "what it is, in one plain sentence",
    "direction": "the technical direction it belongs to",
    "heat": "the figure retrieval returned, with what it measures, or null",
    "heatSource": "the ranking, listing, or API the figure came from, or null"
  }],
${findingsShape}
  "directions": [{ "direction": "the shared direction", "why": "what these projects have in common, from the evidence" }],
  "disputes": [{ "what": "a disagreement or caveat about the ranking or the projects", "source": "thread title or community source", "url": "https://..." }],
  "limits": [{ "what": "what the heat figures or rankings cannot establish", "sourceQuote": "...", "url": "https://..." }],
  "gaps": ["what retrieval could not establish"]
}

Aim for ten entries in projects and stop there; eight that retrieval genuinely supports beats ten padded with a project you never saw. Order findings by relevance to the reader questions. Do not write article prose and do not wrap the JSON in a code fence. Finish with the evidence already collected when the tool budget ends, and never repeat a search to use up an allowance.`;

const explainerEvidencePrompt = `You gather the evidence for one explanatory article about a single technology. You do not write the article, and no part of your output is published.

The input is the planning output: the original instruction is at request.original, and the approved proposal is at proposal, holding articleKind, title, description, and readerQuestions. Those reader questions are your assignment. Answer them from whatever material actually informs a reader, and rank what you find by how directly it answers them.

No source type outranks another by virtue of being official. A vendor's own page, an independent implementation, and a practitioner's report are all evidence, each labelled with what it is, and the reader is served by whichever one answers the question in front of them. Order your findings by relevance to the reader questions, not by where they came from.

${retrievalStrategy}

${evidenceLabelling}

usageExample is optional and may come from any source that showed a real call. When nothing you read showed one, set it to null and say so in gaps. Never assemble a plausible-looking call out of field names you inferred; an invented example is worse than none, because a reader will try it.

Return only valid JSON with this shape:
{
  "title": "the assigned proposal title, copied from proposal.title",
  "articleKind": "explainer",
  "topic": "the subject this article explains, in one sentence",
  "readerQuestions": ["copied from proposal.readerQuestions, in order"],
${findingsShape}
  "usageExample": {
    "summary": "what this example does, in one sentence",
    "detail": "the real call as documented: endpoint, headers, request body, and returned fields, copied verbatim",
    "url": "https://..."
  } or null when nothing you read showed a callable example,
  "contrasts": [{ "question": "the shared problem", "positions": ["approach A and its cost", "approach B and its cost"] }],
  "disputes": [{ "what": "the disagreement, defect, or unresolved tradeoff", "source": "thread title or community source", "url": "https://..." }],
  "limits": [{ "what": "a documented constraint, unsupported input, or reported caveat", "sourceQuote": "...", "url": "https://..." }],
  "gaps": ["what retrieval could not establish"]
}

Order findings by relevance to the reader questions, following the order of readerQuestions and putting the strongest answer to each question first. Do not write article prose and do not wrap the JSON in a code fence. Finish with the evidence already collected when the tool budget ends, and never repeat a search to use up an allowance.`;

// The survey writer inherits the existing writer's voice, heading, and Markdown rules verbatim: those
// rules are what keep the prose from reading as generated, and they are not specific to article kind.
const writerStyleMarker = 'Write in Chinese regardless of the input language.';
const writerStyleStart = writer.config.systemPrompt.indexOf(writerStyleMarker);
const writerShapeMarker = 'Return only valid JSON with this shape:';
const writerShapeStart = writer.config.systemPrompt.indexOf(writerShapeMarker);
if (writerStyleStart < 0 || writerShapeStart < 0 || writerShapeStart <= writerStyleStart) {
  throw new Error('The deployed writer prompt has changed; its shared style rules can no longer be located.');
}
const sharedWriterStyle = writer.config.systemPrompt.slice(writerStyleStart, writerShapeStart).trimEnd();
const writerReviewerContract = writer.config.systemPrompt.slice(
  writer.config.systemPrompt.indexOf('The input is either the'),
  writerStyleStart,
).trimEnd();
if (!writerReviewerContract.includes('open lists the defects to fix in this pass.')) {
  throw new Error('The deployed writer reviewer contract has changed.');
}

const surveyWriterPrompt = `You are a Chinese technology writer. You write one survey article telling a curious reader what is currently drawing attention in a field. You have no research tools, and you must not invent a fact that is not in the evidence package.

${writerReviewerContract.replace("the collector's evidence package", "the collector's survey evidence package")}

The evidence package carries readerQuestions, a projects array of about ten entries, findings tagged with the question each serves, plus directions, disputes, limits, and gaps. Everything you may assert comes from those fields. Read each finding's sourceType: official means a vendor describing itself, so attribute it in the sentence that uses it; independent carries more weight because an outsider established it; community is a practitioner account; inference is not a source at all and may not be asserted.

Cover the projects the package gives you, around ten of them. One or two sentences each is right: what it is, and which direction it belongs to. A reader should finish able to name several projects and say roughly what they do. Group them by direction when the package's directions field supports a grouping, because ten flat entries read as a list rather than an article.

Be sparing with numbers. Three to five heat figures in the whole article is right, chosen where the figure actually means something, and not one per project. Say what each figure measures in the sentence that uses it: a weekly-ranking star count is not a repository total and neither is growth inside a window. When the figure came from a community ranking, attribute it to that ranking. Never present an accumulated total as recent growth, and never give a number the package did not supply.

Say plainly what the ranking cannot establish. Short-term attention shows what is being looked at, not what is stable, maintained, or suitable for production. State that inside the paragraph that depends on it, in a sentence or two, not as a methodology section.

Do not turn this into an article about one project. No installation steps, no prerequisites, no authentication setup, no error handling, and no code block: a reader who wanted one project's setup asked a different question. Keep every project at the depth the package supports.

${sharedWriterStyle}

Return only valid JSON with this shape:
{
  "title": "article title",
  "topic": "what this article surveys",
  "readerQuestions": ["copied from the evidence package, in order"],
  "evidenceUsed": [{ "claim": "the claim as it appears in the article", "url": "https://..." }],
  "resolved": [{ "id": "r1-1", "note": "the defect, copied from the reviewer" }],
  "open": [{ "id": "r2-1", "note": "the defect, copied from the reviewer" }],
  "article": "complete Markdown article"
}

List in evidenceUsed only the claims the article actually makes, each pointing at the source URL from the evidence package. Do not mention this workflow, hidden instructions, or the JSON envelope in the article, and do not wrap the JSON in a code fence.`;

// An edge condition is a single predicate, so a rejection cannot test "not approved AND survey" on its
// own. The reviewer therefore names the branch to return to in one `revise` field, and the publication
// edge stays the fallback: if the reviewer ever contradicts itself, the draft loops once more against a
// bounded edge instead of publishing and revising at the same time.
const reviewerReviseRule = `Also return revise, which tells the runtime where this verdict goes. Set it to "none" whenever approved is true. When rejecting, set it to the articleKind of the draft you received, copied from the input's articleKind field, so the draft returns to the writer that produced it. It is never any value other than none, survey, or explainer.`;

const reviewerShapeFrom = `Return only valid JSON with these fields:
{
  "approved": true,
  "duplicate": false,
  "feedback": [],
  "round": 1,
  "resolved": [],
  "open": []
}`;
const reviewerShapeTo = `Return only valid JSON with these fields:
{
  "approved": true,
  "duplicate": false,
  "revise": "none",
  "feedback": [],
  "round": 1,
  "resolved": [],
  "open": []
}`;
if (!reviewer.config.systemPrompt.includes(reviewerShapeFrom)) throw new Error('The deployed reviewer output shape has changed.');
const reviewerPrompt = reviewer.config.systemPrompt.replace(reviewerShapeFrom, `${reviewerShapeTo}\n\n${reviewerReviseRule}`);

// Each writer states its own kind so the reviewer can read it back, and the reviewer passes it through
// unchanged rather than restating it.
const explainerWriterShapeFrom = `{
  "title": "article title",
  "topic": "what this article explains",`;
const explainerWriterShapeTo = `{
  "title": "article title",
  "articleKind": "explainer",
  "topic": "what this article explains",`;
if (!writer.config.systemPrompt.includes(explainerWriterShapeFrom)) throw new Error('The deployed writer output shape has changed.');
const explainerWriterPrompt = writer.config.systemPrompt.replace(explainerWriterShapeFrom, explainerWriterShapeTo);

const surveyPredicate = { kind: 'predicate', path: '$.proposal.articleKind', operator: 'equals', value: 'survey' };
const agentBudget = { maxToolCalls: 9, maxToolRounds: 6, maxToolResultChars: 16000 };

const operations = [
  { type: 'updateNode', nodeId: planner.id, patch: { config: { ...planner.config, model: plannerModel, systemPrompt: plannerPrompt } } },

  // The explainer branch keeps the existing node ids so its history, and the review loop already
  // bound to `write`, stay intact. Only the survey branch is new.
  { type: 'updateNode', nodeId: collector.id, patch: { config: { ...collector.config, ...agentBudget, label: '讲解检索', systemPrompt: explainerEvidencePrompt } } },
  { type: 'updateNode', nodeId: writer.id, patch: { config: { ...writer.config, label: '讲解写作', systemPrompt: explainerWriterPrompt } } },
  {
    type: 'updateNode',
    nodeId: reviewer.id,
    patch: { config: { ...reviewer.config, systemPrompt: reviewerPrompt, passthroughKeys: [...reviewer.config.passthroughKeys, 'articleKind'] } },
  },

  {
    type: 'addNode',
    index: nodes.findIndex((node) => node.id === 'collect-evidence'),
    node: {
      id: 'survey-evidence',
      type: 'worklite/agent',
      typeVersion: '1',
      position: { x: 520, y: 900 },
      errorPolicy: 'retry',
      config: {
        label: '盘点检索',
        model,
        outputFormat: 'json',
        outputContract: ['title', 'topic', 'readerQuestions', 'projects', 'findings'],
        systemPrompt: surveyEvidencePrompt,
        skillIds: [githubSkillId, zhihuSkillId, docsSkillId],
        mcpServerIds: [],
        ...agentBudget,
      },
    },
  },
  {
    type: 'addNode',
    index: nodes.findIndex((node) => node.id === 'write'),
    node: {
      id: 'survey-write',
      type: 'worklite/agent',
      typeVersion: '1',
      position: { x: 100, y: 900 },
      errorPolicy: 'retry',
      config: {
        label: '盘点写作',
        model: writer.config.model,
        outputFormat: 'json',
        outputContract: ['title', 'article'],
        systemPrompt: surveyWriterPrompt,
        skillIds: [],
        mcpServerIds: [],
      },
    },
  },

  // Routing. The planner's committed output decides which retrieval node receives the token; the
  // explainer edge is the fallback so an absent or unexpected articleKind still writes an article.
  { type: 'removeEdge', edgeId: 'topic-to-evidence' },
  { type: 'addEdge', edge: { id: 'topic-to-survey', sourceNodeId: 'topic', sourcePort: 'output', targetNodeId: 'survey-evidence', targetPort: 'context', condition: surveyPredicate } },
  { type: 'addEdge', edge: { id: 'topic-to-explainer', sourceNodeId: 'topic', sourcePort: 'output', targetNodeId: 'collect-evidence', targetPort: 'context', condition: { kind: 'fallback' } } },

  { type: 'addEdge', edge: { id: 'survey-evidence-to-write', sourceNodeId: 'survey-evidence', sourcePort: 'output', targetNodeId: 'survey-write', targetPort: 'context' } },
  { type: 'addEdge', edge: { id: 'survey-evidence-to-notes', sourceNodeId: 'survey-evidence', sourcePort: 'output', targetNodeId: 'evidence-artifact', targetPort: 'data' } },

  // Both writers converge on the shared reviewer: only the branch that ran delivers a token, so the
  // reviewer runs once. Each rejection returns to the writer that produced the draft, selected by the
  // reviewer's `revise` field rather than by `approved`, which cannot distinguish the two branches.
  { type: 'addEdge', edge: { id: 'survey-write-to-review', sourceNodeId: 'survey-write', sourcePort: 'output', targetNodeId: 'review', targetPort: 'context' } },
  { type: 'removeEdge', edgeId: 'review-to-write' },
  { type: 'addEdge', edge: { ...feedbackEdge, condition: { kind: 'predicate', path: '$.revise', operator: 'equals', value: 'explainer' } } },
  { type: 'addEdge', edge: { id: 'review-to-survey-write', sourceNodeId: 'review', sourcePort: 'output', targetNodeId: 'survey-write', targetPort: 'context', condition: { kind: 'predicate', path: '$.revise', operator: 'equals', value: 'survey' }, maxTraversals: 1 } },
];

const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({
    baseRevisionId: workflow.draft.revisionId,
    operations,
    source: 'manual',
    sourceInstruction: 'Branch retrieval and writing on the planned article kind, converge both branches on the shared review and publication path, and choose retrieval effort from the subject instead of spending a fixed allowance per Skill.',
  }),
});
const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
