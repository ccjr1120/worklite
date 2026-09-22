#!/usr/bin/env node

// The survey branch returned two projects instead of ten. It inherited the explanatory branch's
// retrieval shape, which reads four repositories in full: a depth setting that answers "how does X
// work" and starves "what is getting attention". Four deep reads also overran the tool-result budget,
// so the listings it did receive were truncated and dropped from context.
//
// This switches the survey branch to breadth (thirty listings, one deep read), cuts its GitHub queries
// to three so the Skill's own five-query quota is never hit, and makes community search mandatory for
// a survey because the GitHub API reports accumulated stars and cannot report recent growth at all.
const baseUrl = process.env.WORKLITE_API_URL?.replace(/\/$/, '');
if (!baseUrl) throw new Error('Set WORKLITE_API_URL to the deployment API URL before editing the workflow.');

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

const workflow = await request(`/workflows/${workflowId}`);
if (workflow.name !== 'GitHub Technology Trend Research' || !workflow.draft?.revisionId) {
  throw new Error('The target workflow or its draft revision is not available.');
}

const { nodes } = workflow.draft.definition;
const nodeById = (id) => {
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Expected workflow node ${id} is missing.`);
  return node;
};
const surveyCollector = nodeById('survey-evidence');
const reviewer = nodeById('review');

const replace = (prompt, pairs, label) => pairs.reduce((text, [from, to]) => {
  if (!text.includes(from)) throw new Error(`The deployed ${label} prompt no longer contains: ${from.slice(0, 70)}`);
  return text.replace(from, to);
}, prompt);

const surveyPrompt = replace(surveyCollector.config.systemPrompt, [
  // Breadth over depth. The last argument is the number of repositories read in full; 12/4 returned four
  // READMEs and starved the listing, while 30/1 returns sixty names across two calls and fits the budget.
  [
    'Call each Skill in its own form. The GitHub Skill takes the query first: research.mjs "<query>" 7 12 4.',
    'Call each Skill in its own form. The GitHub Skill takes the query first, and for a survey you always call it in breadth: research.mjs "<query>" 7 30 1. The last argument is how many repositories it reads in full. Keep it at 1. A higher value returns several complete READMEs, commit logs and issue threads, which fills your tool-result budget with one project\'s internals, truncates the listing you actually need, and drops your earlier results out of context. You want sixty project names, not four source-code reviews.',
  ],
  // The Skill enforces five distinct queries itself. Asking for four invited a sixth that was refused.
  [
    'Give the primary source up to four distinct queries. Give a secondary source one or two, and only for the side the primary cannot show',
    'Give the primary source at most three distinct queries, because the Skill refuses a sixth distinct query and a refused call still costs you the round. Give a secondary source one or two, and only for the side the primary cannot show',
  ],
  // "Skip an irrelevant source" was read as licence to skip Zhihu entirely, which removed the only
  // source that reports recent movement rather than accumulated totals.
  [
    'A source with nothing to contribute to this subject gets no call at all, and calling it anyway to use up an allowance is wasted retrieval, not thoroughness.',
    'A source with nothing to contribute to this subject gets no call at all, and calling it anyway to use up an allowance is wasted retrieval, not thoroughness. Community search is the exception and is never skipped for a survey: the GitHub API reports a repository\'s accumulated star total and cannot report movement inside a window, so a weekly or monthly ranking from community search is the only place recent attention is actually measured. Spend one or two Zhihu queries on such a ranking before you write.',
  ],
  [
    'Do not descend into one project\'s setup, prerequisites, authentication, or error handling.',
    'Do not descend into one project. Read no repository in depth, chase no issue thread, and open no release notes for a single project: one paragraph of listing data about ten projects is worth more here than everything there is to know about one. Do not gather setup steps, prerequisites, authentication, or error handling either.',
  ],
], 'survey collector');

// An output contract can only require a key to be non-empty, so two projects satisfied it and a thin
// survey reached publication unchallenged. The reviewer is where coverage becomes a defect, and its
// rejection re-runs retrieval through the existing bounded feedback edge.
const reviewerCoverageRule = `One check applies only when the draft you received has articleKind "survey". A survey must actually survey: count the distinct projects the article names and reject the draft when it covers fewer than six, because an article promising a field and delivering two projects has answered a different question than the reader asked. Say in the defect how many it covered. This is a coverage defect, not a writing defect, and it counts towards the three you may report.`;

const reviewerAnchor = 'Return only valid JSON with these fields:';
const reviewerPrompt = replace(reviewer.config.systemPrompt, [
  [reviewerAnchor, `${reviewerCoverageRule}\n\n${reviewerAnchor}`],
], 'reviewer');

const operations = [
  { type: 'updateNode', nodeId: surveyCollector.id, patch: { config: { ...surveyCollector.config, systemPrompt: surveyPrompt } } },
  { type: 'updateNode', nodeId: reviewer.id, patch: { config: { ...reviewer.config, systemPrompt: reviewerPrompt } } },
];

const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({
    baseRevisionId: workflow.draft.revisionId,
    operations,
    source: 'manual',
    sourceInstruction: 'Retrieve survey evidence in breadth rather than depth, require community ranking data for recent attention, and reject a survey that covers fewer than six projects.',
  }),
});
const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
