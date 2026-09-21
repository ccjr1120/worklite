#!/usr/bin/env node

// Replaces the two-stage official/community collector with one relevance-ordered evidence node, and
// repairs the documentation Skill so a page URL always comes from retrieval instead of a guessed host.
const baseUrl = process.env.WORKLITE_API_URL?.replace(/\/$/, '');
if (!baseUrl) throw new Error('Set WORKLITE_API_URL to the deployment API URL before updating the workflow.');

const workflowId = 'wf_d625cc98-dcdf-4305-98ec-11bca859eb46';
const docsSkillId = 'sk_ea37cc32-6f30-47d1-a120-2ebef9321d30';
const githubSkillId = 'sk_029f68e6-1b9e-4a65-a230-be02a78e5521';
const zhihuSkillId = 'sk_fa6143da-e62d-4a16-bbf8-bd8df148dba2';

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

const [workflow, providers] = await Promise.all([
  request(`/workflows/${workflowId}`),
  request('/portkey-gateway/providers'),
]);

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

const official = nodeById('collect-official');
const community = nodeById('collect-community');
const writer = nodeById('write');
for (const id of ['topic-to-official', 'official-to-community', 'community-to-evidence', 'community-to-write']) edgeById(id);
if (nodes.some((node) => node.id === 'collect-evidence')) throw new Error('The merged evidence node already exists; this migration has run.');

const model = community.config.model;
const [providerName, ...modelParts] = model.split('/');
const modelId = modelParts.join('/');
const provider = providers.find((item) => item.name === providerName);
if (!modelId || !provider?.models?.includes(modelId)) throw new Error(`Deployment model ${model} is unavailable.`);

const writerMarker = 'Everything you may assert comes from the official, community, usageExample, limits, contrasts, and disputes fields.';
if (!writer.config.systemPrompt.includes(writerMarker)) {
  throw new Error('The deployed writer prompt has changed; do not edit it by text substitution.');
}

const evidencePrompt = `You gather the evidence for one explanatory technology article. You do not write the article, and no part of your output is published.

The input is the planning output: the original instruction is at request.original, and the approved proposal is at proposal, holding title, description, and readerQuestions. Those reader questions are your assignment. Answer them from whatever material actually informs a reader, and rank what you find by how directly it answers them.

No source type outranks another by virtue of being official. A vendor's own page, an independent implementation, and a practitioner's report are all evidence, each labelled with what it is, and the reader is served by whichever one answers the question in front of them. Order your findings by relevance to the reader questions, not by where they came from.

Work in this order, because two of your three Skills need only a subject name while the third needs a URL that does not exist until retrieval produces one.

1. Search GitHub with the research Skill. At most three distinct queries.
2. Search Zhihu. At most three distinct queries. This allowance is separate from the GitHub one, so spending GitHub queries never makes Zhihu unavailable.
3. Read documentation pages with official-docs-fetch, but only for addresses the first two steps actually returned: a link in a README, a release note, or a source URL under a Zhihu answer. At most two calls, at most four pages in total.

Never construct a documentation address. Do not infer a hostname from the subject's name, do not append a path you have not seen, and do not try a domain to find out whether it exists. Every URL you pass to official-docs-fetch must appear in a result an earlier call returned. If no documentation address surfaced, do not call that Skill at all: an evidence package with no official entry is a normal outcome and needs no gap entry explaining it.

Stop when the reader questions are covered, even with allowance left. You have enough when every question has at least one finding, and when at least one finding either confirms or complicates another. Retrieval that has already answered a question is finished retrieval.

Do not keep fetching because addresses remain unread. When retrieval hands you more documentation links than your four pages, choose the four that answer distinct reader questions, one page per question, and pass them in a single call. Prefer an overview, a quick start, or an API reference, which answer a reader's question directly. Skip a changelog, a link index, or an awesome list, which tell you a page exists and nothing else. Spend the second call only when the first revealed a specific page you still need; ending after one call is a good outcome.

Your context window is the other reason to stop early. Every page and every result stays in your context, and once the window fills the engine silently drops your earliest messages, so evidence you gathered first disappears and you will believe you never gathered it. Write the quotes you need into your output as you go. Both search Skills and the documentation Skill report when a query or URL was already served: that notice means you already hold the material, so move on rather than rephrasing the same request.

A repository description states what a project claims to be. Draw mechanism from README text, real progress from commit subjects and release notes, and disagreement from issue and pull request discussion.

Label every finding with what it is, and keep the voices separate. A claim from the subject's own documentation is the vendor describing itself; mark it official and attribute it. An outside measurement or a working reimplementation is independent and carries more weight. A practitioner account is community. Your own reasoning is inference and is not a source. A number the vendor published and a blogger repeated is still the vendor's number.

What you retrieved is verified material. An endpoint, an authentication header, a request body, a field name, a type value, or a code sample that appears in something you fetched must be copied into your output exactly as it was given, including its letter case. Never report retrieved content as unavailable: the material is in your context whether or not it looks complete to you.

usageExample is optional and may come from any source that showed a real call. When nothing you read showed one, set it to null and say so in gaps. Never assemble a plausible-looking call out of field names you inferred; an invented example is worse than none, because a reader will try it.

Record in gaps what retrieval could not establish, naming the Skill that refused if one did. gaps is for absent content, not for material you chose not to trust, and not for documentation you correctly declined to go looking for.

Return only valid JSON with this shape:
{
  "title": "the assigned proposal title, copied from proposal.title",
  "topic": "the subject this article explains, in one sentence",
  "readerQuestions": ["copied from proposal.readerQuestions, in order"],
  "findings": [{
    "question": "the reader question this serves, copied",
    "point": "what a reader should learn here, stated concretely",
    "sourceType": "official|independent|community|inference",
    "sourceQuote": "the passage, commit subject, or thread title behind it",
    "url": "https://..."
  }],
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

// The writer's three references to the split evidence fields are replaced rather than appended to, so
// no instruction survives telling it to read an `official` array the collector no longer produces.
const writerReplacements = [
  [
    'The evidence package carries readerQuestions plus official and community material tagged with the question each one serves.',
    'The evidence package carries readerQuestions plus findings, each tagged with the question it serves and with what kind of source it came from.',
  ],
  [
    'Everything you may assert comes from the official, community, usageExample, limits, contrasts, and disputes fields. The official entries are the vendor describing itself, so attribute them in the sentence that uses them; a community entry marked independent carries more weight and one marked inference is not a source at all.',
    'Everything you may assert comes from the findings, usageExample, limits, contrasts, and disputes fields. Read each finding\'s sourceType: official means the vendor describing itself, so attribute it in the sentence that uses it; independent carries more weight because an outsider established it; community is a practitioner account; inference is not a source at all and may not be asserted. The findings are ordered by how directly they answer the reader questions, so a finding is not more authoritative for being official, only differently attributed.',
  ],
  [
    'Never invent the contents of an example. Field names, parameter names, type values, request shapes, response shapes, and every number in an example come from usageExample or from the answers material, copied as they appear.',
    'Never invent the contents of an example. Field names, parameter names, type values, request shapes, response shapes, and every number in an example come from usageExample or from the findings, copied as they appear.',
  ],
];

const writerPrompt = writerReplacements.reduce((prompt, [from, to]) => {
  if (!prompt.includes(from)) throw new Error(`The deployed writer prompt no longer contains: ${from.slice(0, 60)}...`);
  return prompt.replace(from, to);
}, writer.config.systemPrompt);

const operations = [
  {
    type: 'addNode',
    index: nodes.findIndex((node) => node.id === 'collect-official'),
    node: {
      id: 'collect-evidence',
      type: 'worklite/agent',
      typeVersion: '1',
      position: { x: 760, y: 620 },
      errorPolicy: 'retry',
      config: {
        model,
        outputFormat: 'json',
        outputContract: ['title', 'topic', 'readerQuestions', 'findings'],
        systemPrompt: evidencePrompt,
        skillIds: [githubSkillId, zhihuSkillId, docsSkillId],
        mcpServerIds: [],
        maxToolCalls: 9,
        maxToolRounds: 6,
        maxToolResultChars: 16000,
      },
    },
  },
  { type: 'removeNode', nodeId: official.id },
  { type: 'removeNode', nodeId: community.id },
  { type: 'addEdge', edge: { id: 'topic-to-evidence', sourceNodeId: 'topic', sourcePort: 'output', targetNodeId: 'collect-evidence', targetPort: 'context' } },
  { type: 'addEdge', edge: { id: 'evidence-to-notes', sourceNodeId: 'collect-evidence', sourcePort: 'output', targetNodeId: 'evidence-artifact', targetPort: 'data' } },
  { type: 'addEdge', edge: { id: 'evidence-to-write', sourceNodeId: 'collect-evidence', sourcePort: 'output', targetNodeId: 'write', targetPort: 'context' } },
  { type: 'updateNode', nodeId: writer.id, patch: { config: { ...writer.config, systemPrompt: writerPrompt } } },
];

const docsSkill = await request(`/skills/${docsSkillId}`);
const docsScript = docsSkill.files.find((file) => file.path === 'scripts/docs.mjs');
const docsReadme = docsSkill.files.find((file) => file.path === 'SKILL.md');
if (!docsScript || !docsReadme) throw new Error('The official-docs-fetch Skill files are not available.');
for (const marker of ['`https://docs.${host}/${p.replace(/^\\//, \'\')}`', "const candidates = [`https://docs.${host}/llms.txt`", 'const paths = process.argv.slice(3).slice(0, MAX_PAGES_PER_CALL);']) {
  if (!docsScript.content.includes(marker)) throw new Error(`The deployed docs Skill script has changed; it no longer contains: ${marker.slice(0, 50)}`);
}

const patchedScript = docsScript.content
  .replace(
    'const paths = process.argv.slice(3).slice(0, MAX_PAGES_PER_CALL);',
    `const requestedPaths = process.argv.slice(3);
const paths = requestedPaths.slice(0, MAX_PAGES_PER_CALL);
// Silently dropping the surplus makes the agent believe it read pages that were never fetched, so the
// pages it does not get are named back to it.
const droppedPaths = requestedPaths.slice(MAX_PAGES_PER_CALL);`,
  )
  .replace(
    "const candidates = [`https://docs.${host}/llms.txt`, `https://${host}/llms.txt`, `https://www.${host}/llms.txt`];",
    "const candidates = [`https://${host}/llms.txt`, `https://docs.${host}/llms.txt`, `https://www.${host}/llms.txt`];",
  )
  .replace(
    `    const url = /^https?:\\/\\//.test(p)
      ? p
      : \`https://docs.\${host}/\${p.replace(/^\\//, '')}\`;
    return fetchOne(url, state);`,
    `    if (/^https?:\\/\\//.test(p)) return fetchOne(p, state);
    // A bare path used to be rewritten onto the docs. subdomain unconditionally, so every site that
    // serves its documentation from the apex domain returned nothing but 404s. Try the host as given
    // first and report which candidate answered.
    const suffix = p.replace(/^\\//, '');
    const attempts = [\`https://\${host}/\${suffix}\`, \`https://docs.\${host}/\${suffix}\`];
    let last = null;
    for (const candidate of attempts) {
      const result = fetchOne(candidate, state);
      if (result.text || result.alreadyFetched) return result;
      last = result;
    }
    return { ...last, attempted: attempts };`,
  )
  .replace(
    "  return { url, status: direct.status, error: 'not retrievable' };",
    `  // "not retrievable" for both a 404 and a dead connection left the agent guessing at the cause, and
  // it guessed wrong in production, reporting a TLS failure for a page that answered 404.
  return { url, status: direct.status, error: direct.status === 0 ? 'the request did not complete: no HTTP response was received' : \`the server answered HTTP \${direct.status}\` };`,
  );

if (patchedScript === docsScript.content) throw new Error('The docs Skill script patch produced no change.');

const patchedScriptWithNotice = patchedScript.replace(
  'state.at = Date.now();',
  `if (droppedPaths.length > 0) {
  out.droppedPaths = droppedPaths;
  out.droppedNote = \`This call accepts at most \${MAX_PAGES_PER_CALL} pages, so \${droppedPaths.length} of your arguments were not fetched and are listed in droppedPaths. Their text is not in your context. Do not assume you read them, and do not re-request them unless one is genuinely needed.\`;
}

state.at = Date.now();`,
);
if (patchedScriptWithNotice === patchedScript) throw new Error('The docs Skill dropped-path notice patch produced no change.');

const patchedReadme = docsReadme.content.replace(
  'Call it with the vendor domain and no paths to discover what exists. The script probes the `docs.` subdomain and the bare domain for a `/llms.txt` index, returns that index, and lists the page paths it found. Call it again with the paths you want; each is fetched as clean Markdown when a `.md` form exists and as tag-stripped text otherwise.',
  `Pass a URL that retrieval already gave you. This Skill reads a page; it does not find one. Take the address from a README link, a release note, or a source link under a search result, and never assemble one from a project's name: a guessed host answers 404 and costs you the call.

Call it with a domain and no paths to look for a \`/llms.txt\` index, which it probes on the bare domain, the \`docs.\` subdomain, and \`www.\`, returning the index and the page paths it lists. Call it again with the pages you want. A full \`https://\` URL is fetched as given. A bare path is tried against the bare domain first and then the \`docs.\` subdomain, and the response names which one answered. Each page comes back as clean Markdown when a \`.md\` form exists and as tag-stripped text otherwise.

A page that could not be read reports why: an HTTP status when the server answered, and a plain statement that no response arrived when the request did not complete. Read that reason rather than inferring one.`,
);
if (patchedReadme === docsReadme.content) throw new Error('The docs Skill README patch produced no change.');

// The graph edit is applied before the Skill is touched, so a rejected operation list leaves both the
// workflow and the Skill on their previous content instead of half-migrating one of them.
const updated = await request(`/workflows/${workflowId}/draft/operations`, {
  method: 'POST',
  body: JSON.stringify({
    baseRevisionId: workflow.draft.revisionId,
    operations,
    source: 'manual',
    sourceInstruction: 'Merge official and community retrieval into one relevance-ordered evidence node, and require documentation URLs to come from retrieval rather than a guessed host.',
  }),
});

await request(`/skills/${docsSkillId}`, {
  method: 'PATCH',
  body: JSON.stringify({ files: [
    ...docsSkill.files.filter((file) => file.path !== 'scripts/docs.mjs' && file.path !== 'SKILL.md').map((file) => ({ path: file.path, content: file.content })),
    { path: 'SKILL.md', content: patchedReadme },
    { path: 'scripts/docs.mjs', content: patchedScriptWithNotice },
  ] }),
});

const version = await request(`/workflows/${workflowId}/publish`, { method: 'POST' });
process.stdout.write(JSON.stringify({ workflowId, draftRevisionId: updated.draft.revisionId, publishedVersionId: version.id, version: version.version }) + '\n');
