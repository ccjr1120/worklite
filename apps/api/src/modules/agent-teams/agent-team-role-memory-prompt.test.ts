import { describe, expect, it } from 'vitest';
import type { AgentTeamTaskRequest } from '@worklite/team-runtime';
import type { StoredAgentTeamVersionSnapshot } from '@worklite/db';
import { groupRolePromptAddition } from './agent-team-runtime.service';
import { TEAM_MEMORY_INDEX_CHARS, TEAM_MEMORY_INDEX_ENTRIES } from './team-memory-ranking';

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
    authorizedCommands: [],
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

describe('groupRolePromptAddition v10 compatibility', () => {
  it('keeps the v10 initially addressed projection byte-for-byte', () => {
    const addition = groupRolePromptAddition(
      snapshot(10),
      request('group_0_planner', 'planner', [{ id: 'memory_1', repositoryId: null, role: null, content: 'Deploy with the release script.' }]),
    );

    expect(addition).toBe([
      'This is the initially addressed role for a Chat-dispatched Agent Team Run. Use the captured Team context to guide this request.',
      'Team working practice:\nPrefer small reviewed changes.',
      'Team memories:\n- Deploy with the release script.',
      'Team settings, roles and memories are managed by Chat through protected platform operations. Do not claim to read or change Team memories or settings yourself.',
    ].join('\n'));
  });

  it('keeps v10 handoff roles without Team memory access', () => {
    const addition = groupRolePromptAddition(
      snapshot(10),
      request('group_1_developer', 'developer', [{ id: 'memory_1', repositoryId: null, role: null, content: 'Deploy with the release script.' }]),
    );

    expect(addition).toContain('Only the initially addressed role in a new v8-v10 Run receives its bounded captured memory projection; handoff roles receive none');
    expect(addition).not.toContain('team_memory_search');
  });
});

describe('groupRolePromptAddition v11', () => {
  it('keeps the full projection for the initially addressed role and advertises the tools', () => {
    const addition = groupRolePromptAddition(
      snapshot(11),
      request('group_0_planner', 'planner', [{ id: 'memory_1', repositoryId: null, role: null, content: 'Deploy with the release script.' }]),
    );

    expect(addition).toContain('Team memories:\n- Deploy with the release script.');
    expect(addition).toContain('team_memory_search');
    expect(addition).toContain('team_memory_write');
    expect(addition).not.toContain('Team memory index');
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
    expect(addition).not.toContain('Team working practice:');
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
        { id: 'current', repositoryId: null, role: null, content: 'Current Team fact.' },
      ]),
    )!;

    expect(addition).toContain('Current Team fact.');
    expect(addition).not.toContain('Legacy role-only fact.');
  });
});
