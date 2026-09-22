#!/usr/bin/env node

// Three defects from the v22 run.
//
// 1. Community search was skipped entirely. Restricting its query shape was right, but the escape
//    clause next to it ("skip them when GitHub returned nothing worth asking about") let the whole
//    step go. Requiring the call and constraining its wording are not in conflict.
// 2. Six tool rounds produced three distinct queries: two were sent twice. The Skill answers a repeat
//    from cache with a repeatedCall note, which the model read as a failed call and retried, and the
//    lost rounds took the retrieval budget with them.
// 3. One of those three queries was the bare word LLM, so the results were whatever had been created
//    recently, and eight of ten projects landed between 164 and 522 stars.
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
const surveyCollector = nodes.find((node) => node.id === 'survey-evidence');
if (!surveyCollector) throw new Error('The survey collector node is missing.');

const replace = (prompt, pairs, label) => pairs.reduce((text, [from, to]) => {
  if (!text.includes(from)) throw new Error(`The deployed ${label} prompt no longer contains: ${from.slice(0, 70)}`);
  return text.replace(from, to);
}, prompt);

const surveyPrompt = replace(surveyCollector.config.systemPrompt, [
  // Constrain the wording, keep the obligation. The previous escape clause removed the step entirely.
  [
    'Spend one or two such queries, and skip them when GitHub returned nothing worth asking about.',
    'Spend one or two such queries, and do not finish a survey without them: a reader learns from what practitioners make of these projects, which GitHub listings cannot tell them. The constraint is on the wording, not on whether you call it. If a project name returns nothing useful, query its direction in Chinese instead rather than dropping the step.',
  ],
  // A repeat answers from cache, which the model read as failure and retried until the rounds ran out.
  [
    'Give the primary source at most three distinct queries, because the Skill refuses a sixth distinct query and a refused call still costs you the round.',
    `Give the primary source at most three distinct queries, because the Skill refuses a sixth distinct query and a refused call still costs you the round.

Send each query once. A Skill answers a query it already ran from its cache and says so with a repeatedCall or alreadyFetched note; that note means the result is in your hands, not that the call failed, so re-sending it returns the same text and costs a round you needed for the next source. Before every call, check the queries you have already sent this round-trip against the one you are about to send. If a result looked thin, the answer is a different query or a different Skill, never the same query again.

Make each query specific enough to separate one direction from another: two or three words naming a technical direction, such as "AI coding agent" or "MCP database connector". A single broad word like LLM or AI returns whatever was created most recently, which fills the survey with week-old repositories instead of the projects a reader would recognise.`,
  ],
], 'survey collector');

const operations = [
  {
    type: 'updateNode',
    nodeId: surveyCollector.id,
    // Six rounds were consumed by GitHub alone, leaving none for community search even when the model
    // intended to use it. Eight leaves room for three GitHub calls, two Zhihu calls, and the writing turn.
    patch: { config: { ...surveyCollector.config, systemPrompt: surveyPrompt, maxToolRounds: 8, maxToolCalls: 10 } },
  },
];

const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({
    baseRevisionId: workflow.draft.revisionId,
    operations,
    source: 'manual',
    sourceInstruction: 'Require community search while keeping its query shape constrained, stop repeated queries from consuming the retrieval budget, and reject single-word queries that return only recently created repositories.',
  }),
});
const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
