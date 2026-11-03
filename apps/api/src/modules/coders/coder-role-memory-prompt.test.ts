import { describe, expect, it } from 'vitest';
import type { AgentTeamTaskRequest } from '@worklite/team-runtime';
import type { StoredAgentTeamVersionSnapshot } from '@worklite/db';
import { groupRolePromptAddition, rolePromptAddition } from './coder-runtime.service';
import { TEAM_MEMORY_INDEX_CHARS, TEAM_MEMORY_INDEX_ENTRIES } from './coder-memory-ranking';

function snapshot(): StoredAgentTeamVersionSnapshot {
  return {
    processId: 'bmad-tea',
    processVersion: '1',
    coderName: 'Test Coder',
    projectExecutorLaunches: {},
    orchestrationVersion: 12,
    workingPractice: 'Prefer small reviewed changes.',
    roles: [
      { role: 'router', publicModelId: '', instructions: '', entryPoints: [], skills: [], mcpServers: [], toolNames: ['read', 'grep'] },
      { role: 'planner', publicModelId: '', instructions: '', entryPoints: [], skills: [], mcpServers: [], toolNames: ['read', 'grep'] },
      { role: 'implementer', displayName: 'Implementer', publicModelId: '', instructions: '', entryPoints: [], skills: [], mcpServers: [], executor: 'claude', toolNames: ['read', 'write'] },
    ],
    processFiles: [],
    recipeDefaults: { maxRepairRounds: 1 },
  } as StoredAgentTeamVersionSnapshot;
}

function request(taskKey: string, role: string, memories: Array<{ id: string; repositoryId: string | null; content: string }>): AgentTeamTaskRequest {
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
    projectDirectory: '/projects/api',
    outputDirectory: '/projects/output',
    scopeRevision: 1,
    projectInstructions: [],
    upstream: [],
    groupContext: {
      groupId: 'atgroup_prompt',
      initialMessageId: 'atmsg_prompt',
      initialMessage: 'Fix the authentication timeout in the API',
      targetRole: 'router',
      requestedRole: 'planner',
      repositories: [
        { id: 'group_repo_api', memoryRepositoryId: 'repo_api', name: 'api', directory: '/projects/api', projectInstructions: [] },
      ],
      memories,
    },
  } as AgentTeamTaskRequest;
}

describe('v12 Router prompts', () => {
  it('keeps Router as the sole coordinator and only exposes configured role capabilities', () => {
    const addition = rolePromptAddition('router', snapshot(), request('group_router_0', 'router', []))!;

    expect(addition).toContain('You are Router, the only coordinator for this Run.');
    expect(addition).toContain('Every result returns to Router.');
    expect(addition).toContain('planner: model role');
    expect(addition).toContain('implementer (Implementer): claude execution engine');
    expect(addition).toContain('routerPlan');
    expect(addition).not.toContain('handoff.role');
    expect(addition).not.toContain('Dispatcher');
  });

  it('keeps investigation scoped to the requested work and captured repository', () => {
    const addition = rolePromptAddition('planner', snapshot(), request('group_0_planner', 'planner', []))!;

    expect(addition).toContain('Router assigned this task to you.');
    expect(addition).toContain('return evidence, changed files, documents, and unresolved issues to Router');
    expect(rolePromptAddition('reviewer', snapshot(), request('group_1_reviewer', 'reviewer', []))).toContain('return evidence, changed files, documents, and unresolved issues to Router');
  });

  it('gives Router the full memory projection and assigned roles a bounded title index', () => {
    const memories = Array.from({ length: 40 }, (_, index) => ({
      id: `memory_${index}`,
      repositoryId: index % 2 === 0 ? 'repo_api' : null,
      content: `Authentication decision ${index}\nDetailed body ${index} that must not be projected.`,
    }));
    const router = groupRolePromptAddition(snapshot(), request('group_router_0', 'router', memories))!;
    const assignedRole = groupRolePromptAddition(snapshot(), request('group_1_implementer', 'implementer', memories))!;
    const indexText = assignedRole.split('\n').filter((line) => line.startsWith('- '));

    expect(router).toContain('Coder memories:\n- Authentication decision 0');
    expect(assignedRole).toContain('Coder memory index (');
    expect(indexText.length).toBeLessThanOrEqual(TEAM_MEMORY_INDEX_ENTRIES);
    expect(indexText.reduce((total, line) => total + line.length + 1, 0)).toBeLessThanOrEqual(TEAM_MEMORY_INDEX_CHARS);
    expect(assignedRole).not.toContain('Detailed body');
    expect(assignedRole).toContain('Authentication decision');
    expect(assignedRole).toContain('Return your result to Router.');
    expect(assignedRole).not.toContain('handoff.role');
  });

  it('includes saved goal, progress and documents when Router continues a stopped task', () => {
    const continued = request('group_0_implementer', 'implementer', []);
    continued.groupContext!.continuation = {
      sourceRunId: 'atrun_previous',
      sourceTaskAttemptId: 'attempt_previous',
      taskKey: 'group_1_implementer',
      role: 'implementer',
      goal: 'Fix the missing timeout handling',
      savedProgress: 'Found the failing branch.',
      fileReferences: [{ documentId: 'atdoc_previous', revision: 2, title: 'Implementation notes' }],
    };
    const addition = groupRolePromptAddition(snapshot(), continued)!;

    expect(addition).toContain('Continue task group_1_implementer from its saved goal and progress.');
    expect(addition).toContain('Found the failing branch.');
    expect(addition).toContain('Implementation notes (atdoc_previous, revision 2)');
    expect(addition).toContain('Return your result to Router.');
  });
});
