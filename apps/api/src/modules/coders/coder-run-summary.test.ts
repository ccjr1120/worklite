import { describe, expect, it } from 'vitest';
import type { AgentTeamTaskAttemptView } from '@worklite/contracts';
import type { StoredAgentTeamRoleConfiguration, StoredAgentTeamVersionSnapshot } from '@worklite/db';
import { deriveRunCurrent, effectiveTaskModel, taskRoleName } from './coder-run-summary';

function role(overrides: Partial<StoredAgentTeamRoleConfiguration> & Pick<StoredAgentTeamRoleConfiguration, 'role'>): StoredAgentTeamRoleConfiguration {
  return { publicModelId: '', instructions: '', entryPoints: [], skills: [], mcpServers: [], toolNames: [], ...overrides };
}

function snapshot(overrides: Partial<StoredAgentTeamVersionSnapshot> = {}): StoredAgentTeamVersionSnapshot {
  return {
    processId: 'bmad', processVersion: '1', processFiles: [], recipeDefaults: { maxRepairRounds: 2 },
    coderName: 'Test Coder',
    orchestrationVersion: 12,
    roles: [
      role({ role: 'planner', publicModelId: 'gpt-planner' }),
      role({ role: 'reviewer' }),
      role({ role: 'implementer', executor: 'codex' }),
      role({ role: 'role_custom', displayName: '安全审计', executor: 'claude' }),
    ],
    projectExecutorLaunches: {
      implementer: { executor: 'codex', commandArguments: [], model: 'gpt-codex' },
      role_custom: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1', model: null },
    },
    ...overrides,
  };
}

function attempt(overrides: Partial<AgentTeamTaskAttemptView>): AgentTeamTaskAttemptView {
  return {
    id: 'attempt', taskKey: 'planning', attemptIndex: 0, role: 'planner', status: 'completed', inputFingerprint: '', result: null, error: null,
    assignmentTitle: null, progressText: '', roleName: null, model: null,
    createdAt: '2026-10-23T00:00:00.000Z', startedAt: '2026-10-23T00:00:00.000Z', finishedAt: null,
    ...overrides,
  };
}

describe('Executor Run summary derivation', () => {
  it('reports the configured role model before any fallback', () => {
    expect(effectiveTaskModel(snapshot(), { role: 'planner' }, 'team-default')).toBe('gpt-planner');
  });

  it('falls back to the Coder default model for WorkLite Agent roles without a model', () => {
    expect(effectiveTaskModel(snapshot(), { role: 'reviewer' }, 'team-default')).toBe('team-default');
    expect(effectiveTaskModel(snapshot(), { role: 'reviewer' }, '')).toBeNull();
  });

  it('uses the captured executor launch model for project-executor roles', () => {
    expect(effectiveTaskModel(snapshot(), { role: 'implementer' }, 'team-default')).toBe('gpt-codex');
    expect(effectiveTaskModel(snapshot(), { role: 'role_custom' }, 'team-default')).toBeNull();
  });

  it('names custom roles by their captured display name', () => {
    expect(taskRoleName(snapshot(), 'role_custom')).toBe('安全审计');
    expect(taskRoleName(snapshot(), 'planner')).toBeNull();
  });

  it('leads with the latest started in-flight attempt and counts parallel lanes', () => {
    const current = deriveRunCurrent([
      attempt({ id: 'plan', status: 'completed' }),
      attempt({ id: 'implementer_1', taskKey: 'implementer_1', role: 'implementer', status: 'running', model: 'gpt-codex', startedAt: '2026-10-23T00:05:00.000Z' }),
      attempt({ id: 'implementer_2', taskKey: 'implementer_2', role: 'implementer', status: 'waiting_for_input', model: 'gpt-codex', startedAt: '2026-10-23T00:06:00.000Z' }),
    ]);
    expect(current).toMatchObject({ taskAttemptId: 'implementer_2', role: 'implementer', model: 'gpt-codex', activeCount: 2, activeRoleCount: 1 });
    expect(deriveRunCurrent([attempt({ status: 'completed' })])).toBeNull();
  });
});
