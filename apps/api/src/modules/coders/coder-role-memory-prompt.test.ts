import { describe, expect, it } from 'vitest';
import type { AgentTeamTaskRequest } from '@worklite/team-runtime';
import type { StoredAgentTeamVersionSnapshot } from '@worklite/db';
import { groupRolePromptAddition, rolePromptAddition } from './coder-runtime.service';
import { TEAM_MEMORY_INDEX_CHARS, TEAM_MEMORY_INDEX_ENTRIES } from './coder-memory-ranking';

// v11 gives the initially addressed role the full captured projection and every other
// role a bounded title index. v1-v10 additions are frozen and must not drift.

function snapshot(orchestrationVersion: 10 | 11): StoredAgentTeamVersionSnapshot {
  return {
    processId: 'bmad-tea',
    processVersion: '1',
    developerExecution: { kind: 'codex_app_server' },
    orchestrationVersion,
    workingPractice: 'Prefer small reviewed changes.',
    roles: [],
    processFiles: [],
    recipeDefaults: { maxRepairRounds: 1 },
  } as StoredAgentTeamVersionSnapshot;
}

function request(taskKey: string, role: string, memories: Array<{ id: string; repositoryId: string | null; role: string | null; content: string }>): AgentTeamTaskRequest {
  return {
    runId: 'atrun_prompt',
    taskDefinition: {
      taskKey,
      role,
      goal: 'work',
      dependencyKeys: [],
      inputDocumentVersions: [],
      expectedResultKind: 'text',
      acceptanceCriterionReferences: [],
    },
    intent: 'Fix the authentication timeout in the API',
    mode: 'implement_and_validate',
    projectDirectory: '/projects/api',
    outputDirectory: '/projects/output',
    scopeRevision: 1,
    projectInstructions: [],
    upstream: [],
    groupContext: {
      groupId: 'atgroup_prompt',
      initialMessageId: 'atmsg_prompt',
      initialMessage: 'Fix the authentication timeout in the API',
      targetRole: 'planner',
      mode: 'implement_and_validate',
      repositories: [
        { id: 'group_repo_api', memoryRepositoryId: 'repo_api', name: 'api', directory: '/projects/api', projectInstructions: [] },
      ],
      memories,
    },
  } as AgentTeamTaskRequest;
}

describe('planner investigation guidance', () => {
  it('applies bounded investigation to existing v11 configurations without dropping explicit scope', () => {
    const addition = rolePromptAddition('planner', snapshot(11), request('group_0_planner', 'planner', []));

    expect(addition).toContain('Stop investigating each question when its requested scope is supported by sufficient evidence');
    expect(addition).toContain('Satisfy every explicit requirement');
    expect(addition).toContain('For a request that only asks for read-only investigation or an answer, report the findings in the required Planner document');
    expect(rolePromptAddition('reviewer', snapshot(11))).not.toContain('Scale investigation to the actual request');
  });

  it('asks the Planner for an executable plan document and the Implementer to follow it without re-investigating', () => {
    const withImplementer = {
      ...snapshot(11),
      roles: [{ role: 'planner' }, { role: 'implementer', executor: 'claude' }],
    } as unknown as StoredAgentTeamVersionSnapshot;
    const planner = rolePromptAddition('planner', withImplementer, request('group_0_planner', 'planner', []));
    const implementer = rolePromptAddition('implementer', withImplementer, request('group_1_implementer', 'implementer', []));

    expect(planner).toContain('Issue independent tool calls together in the same round');
    expect(planner).toContain('do not re-investigate them');
    expect(planner).toContain('a change list naming each file path');
    expect(planner).not.toContain('treat it as the decided scope');
    expect(implementer).toContain('treat it as the decided scope');
    expect(implementer).toContain('report the mismatch in unresolvedIssues');
    expect(rolePromptAddition('planner', snapshot(11), request('group_0_planner', 'planner', []))).not.toContain('a change list naming each file path');
  });
});

describe('groupRolePromptAddition v10 compatibility', () => {
  it('keeps the v10 initially addressed projection byte-for-byte', () => {
    const addition = groupRolePromptAddition(
      snapshot(10),
      request('group_0_planner', 'planner', [{ id: 'memory_1', repositoryId: null, role: null, content: 'Deploy with the release script.' }]),
    );

    expect(addition).toBe([
      'This is the initially addressed role for a Chat-dispatched Coder Run. Use the captured Coder context to guide this request.',
      'Coder working practice:\nPrefer small reviewed changes.',
      'Coder memories:\n- Deploy with the release script.',
      'Coder settings, roles and memories are managed by Chat through protected platform operations. Do not claim to read or change Coder memories or settings yourself.',
    ].join('\n'));
  });

  it('keeps v10 handoff roles without Coder memory access', () => {
    const addition = groupRolePromptAddition(
      snapshot(10),
      request('group_1_developer', 'developer', [{ id: 'memory_1', repositoryId: null, role: null, content: 'Deploy with the release script.' }]),
    );

    expect(addition).toContain('Only the initially addressed role in a new v8-v10 Run receives its bounded captured memory projection; handoff roles receive none');
    expect(addition).not.toContain('coder_memory_search');
  });
});

describe('groupRolePromptAddition v11', () => {
  it('keeps the full projection for the initially addressed role and advertises the tools', () => {
    const addition = groupRolePromptAddition(
      snapshot(11),
      request('group_0_planner', 'planner', [{ id: 'memory_1', repositoryId: null, role: null, content: 'Deploy with the release script.' }]),
    );

    expect(addition).toContain('Coder memories:\n- Deploy with the release script.');
    expect(addition).toContain('coder_memory_search');
    expect(addition).toContain('coder_memory_write');
    expect(addition).not.toContain('Coder memory index');
  });

  it('gives handoff roles a bounded title-only index', () => {
    const memories = Array.from({ length: 40 }, (_, index) => ({
      id: `memory_${index}`,
      repositoryId: index % 2 === 0 ? 'repo_api' : null,
      role: null,
      content: `Authentication decision ${index}\nDetailed body ${index} that must not be projected.`,
    }));
    const addition = groupRolePromptAddition(snapshot(11), request('group_1_developer', 'developer', memories))!;

    const indexText = addition.split('\n').filter((line) => line.startsWith('- '));
    expect(addition).toContain('This is an index, not the full text.');
    expect(indexText.length).toBeLessThanOrEqual(TEAM_MEMORY_INDEX_ENTRIES);
    expect(indexText.reduce((total, line) => total + line.length + 1, 0)).toBeLessThanOrEqual(TEAM_MEMORY_INDEX_CHARS);
    expect(addition).not.toContain('Detailed body');
    expect(addition).toContain('[api] Authentication decision');
    expect(addition).not.toContain('Coder working practice:');
  });

  it('ranks memories matching the goal ahead of unrelated ones', () => {
    const addition = groupRolePromptAddition(
      snapshot(11),
      request('group_1_developer', 'developer', [
        { id: 'memory_unrelated', repositoryId: null, role: null, content: 'Prefer tabs in shell scripts.' },
        { id: 'memory_match', repositoryId: null, role: null, content: 'Authentication timeout lives in the gateway client.' },
      ]),
    )!;

    const lines = addition.split('\n').filter((line) => line.startsWith('- '));
    expect(lines[0]).toContain('Authentication timeout');
  });

  it('excludes legacy role-scoped memories from the index', () => {
    const addition = groupRolePromptAddition(
      snapshot(11),
      request('group_1_developer', 'developer', [
        { id: 'legacy', repositoryId: null, role: 'developer', content: 'Legacy role-only fact.' },
        { id: 'current', repositoryId: null, role: null, content: 'Current Coder fact.' },
      ]),
    )!;

    expect(addition).toContain('Current Coder fact.');
    expect(addition).not.toContain('Legacy role-only fact.');
  });
});

describe('handoff role ids', () => {
  it('lists the exact captured role ids with display names and the implementation role', () => {
    const value = {
      ...snapshot(11),
      roles: [
        { role: 'planner' },
        { role: 'implementer', displayName: 'Implementer', executor: 'codex_app_server' },
      ],
    } as unknown as StoredAgentTeamVersionSnapshot;
    const addition = rolePromptAddition('planner', value, request('group_0_planner', 'planner', []));

    expect(addition).toContain('Captured role ids (use the id exactly in handoff.role, not the display name): planner; implementer (display name "Implementer", implementation role).');
  });
});
