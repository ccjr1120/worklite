#!/usr/bin/env node

// Three defects from the v21 run.
//
// 1. Community search was told a survey must never skip it, and it read that as "go find a ranking".
//    Both queries searched for weekly GitHub charts, so the answer to a question about GitHub drifted
//    from GitHub itself to a Chinese site's retelling of it. A survey establishes its facts from the
//    platform being surveyed; community search then says what practitioners make of what was found.
// 2. The reviewer's passthrough required articleKind, but neither writer emitted it, so review failed
//    outright. It also had to guess the branch, and guessed wrong, which would have routed a survey
//    rejection to the explanatory writer.
// 3. Retrieval filled the list with whatever ranked, including an awesome-list and seven repositories
//    under 230 stars, so the survey named projects it could say nothing substantial about.
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
const surveyWriter = nodeById('survey-write');

const replace = (prompt, pairs, label) => pairs.reduce((text, [from, to]) => {
  if (!text.includes(from)) throw new Error(`The deployed ${label} prompt no longer contains: ${from.slice(0, 70)}`);
  return text.replace(from, to);
}, prompt);

const surveyPrompt = replace(surveyCollector.config.systemPrompt, [
  // Community search stops being a second ranking and becomes commentary on what GitHub established.
  [
    'A source with nothing to contribute to this subject gets no call at all, and calling it anyway to use up an allowance is wasted retrieval, not thoroughness. Community search is the exception and is never skipped for a survey: the GitHub API reports a repository\'s accumulated star total and cannot report movement inside a window, so a weekly or monthly ranking from community search is the only place recent attention is actually measured. Spend one or two Zhihu queries on such a ranking before you write.',
    `A source with nothing to contribute to this subject gets no call at all, and calling it anyway to use up an allowance is wasted retrieval, not thoroughness.

The platform being surveyed establishes the facts of the survey. A question about what is drawing attention on GitHub is answered by GitHub: which projects exist, what they are, and what figures GitHub reports. Community search does not supply a competing answer to that question, and a ranking somebody published elsewhere is a retelling, not the measurement.

Community search comes second and works on what GitHub already gave you. Take a project name or a direction from your GitHub results and search for what practitioners say about that: how it is used in practice, why it is being talked about, what people criticise. A query that names a project or direction you retrieved is the right shape. A query hunting for a ranking, a chart, a weekly list, or the word trending is the wrong shape, because it asks another site to answer the question GitHub was asked. Spend one or two such queries, and skip them when GitHub returned nothing worth asking about.

Star growth inside the window is not available to you. The GitHub API reports accumulated totals, and no ranking you find elsewhere is a substitute for the measurement you do not have. Record the totals as totals, record the absence of growth data in gaps, and never carry a figure from a community ranking into a project's heat as though GitHub had reported it.`,
  ],
  // Zhihu's own routing rule still described it as a primary source, which conflicts with the above.
  [
    '- Zhihu is primary when the subject is how Chinese teams adopt, operate, or argue about something, or when the question is about practice rather than code.',
    '- Zhihu is primary when the subject is how Chinese teams adopt, operate, or argue about something, or when the question is about practice rather than code. It is never primary for a survey of a platform, where it follows GitHub and comments on what GitHub returned.',
  ],
  // Rankings surface whatever is new and small; a survey of a field needs projects with something in them.
  [
    'A repository description states what a project claims to be. Draw mechanism from README text, real progress from commit subjects and release notes, and disagreement from issue and pull request discussion.',
    `A repository description states what a project claims to be. Draw mechanism from README text, real progress from commit subjects and release notes, and disagreement from issue and pull request discussion.

Choose projects you can say something substantial about. A search listing ranks whatever matched, which mixes real implementations with directories and week-old repositories carrying a hundred stars, and a survey built from those names tells a reader nothing. Prefer a project with working code, visible recent activity, and a description that states what it does. Leave out an awesome list, a link collection, a template, or a course syllabus: those record that a field exists and are not projects in it. Ten substantial projects is the target, and eight you can characterise honestly beats ten padded with names you know nothing about.`,
  ],
], 'survey collector');

// The reviewer needs the branch it is reviewing, and its passthrough already requires this key.
const surveyWriterPrompt = replace(surveyWriter.config.systemPrompt, [
  [
    `{
  "title": "article title",
  "topic": "what this article surveys",`,
    `{
  "title": "article title",
  "articleKind": "survey",
  "topic": "what this article surveys",`,
  ],
], 'survey writer');

const operations = [
  { type: 'updateNode', nodeId: surveyCollector.id, patch: { config: { ...surveyCollector.config, systemPrompt: surveyPrompt } } },
  { type: 'updateNode', nodeId: surveyWriter.id, patch: { config: { ...surveyWriter.config, systemPrompt: surveyWriterPrompt } } },
];

const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({
    baseRevisionId: workflow.draft.revisionId,
    operations,
    source: 'manual',
    sourceInstruction: 'Establish survey facts from the surveyed platform and use community search only to comment on what it returned, emit articleKind from the survey writer, and require projects substantial enough to characterise.',
  }),
});
const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
