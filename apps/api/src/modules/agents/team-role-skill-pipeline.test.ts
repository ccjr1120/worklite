import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { agentTeams, createDb, initializeDatabase, type Database } from '@worklite/db';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentTeamConfigurationService } from '../agent-teams/agent-team-configuration.service';
import { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';

// End-to-end for the supported integration path: import a local Skill as a
// platform Skill, capture its id on a Team test role, then verify the role's
// runtime context contains the Skill instructions.
const gateway = vi.hoisted(() => ({ runWorkflowAgent: vi.fn() }));
vi.mock('@worklite/model-gateway', () => ({
  createModelGateway: () => ({ runWorkflowAgent: gateway.runWorkflowAgent }),
}));

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

async function setup() {
  const database = createDb(':memory:');
  db = database;
  await initializeDatabase(database);
  database.insert(agentTeams).values({
    id: 'agent_team_bmad_tea',
    workspaceId: 'workspace_personal',
    name: 'Company Project',
    description: '',
    processId: 'bmad-tea',
    processVersion: '1',
    roles: [],
  }).run();
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) };
  const resources = new WorkspaceResourcesService(database, workspaces as never, {} as never, {} as never, {} as never);
  const configuration = new AgentTeamConfigurationService(database, { publicModelRuntime: async () => ({ protocol: 'anthropic/messages' }) } as never);
  return { resources, configuration };
}

describe('Team role Skill pipeline', () => {
  it('carries an imported platform Skill from role skillIds into the runtime prompt', async () => {
    const { resources, configuration } = await setup();
    const skill = await resources.importSkill({} as Request, 'personal', {
      name: 'dino-cli',
      files: [
        { path: 'SKILL.md', content: '# Dino CLI\nUse `dino-cli account current` before any account command.' },
        { path: 'references/commands.md', content: 'account login -e <email>\naccount admin-login' },
      ],
    });

    const team = await configuration.update('workspace_personal', 'agent_team_bmad_tea', {
      roles: [
        {
          role: 'dispatcher',
          publicModelId: '',
          instructions: 'Dispatch the request.',
          entryPoints: [],
          skillIds: [],
          mcpServerIds: [],
          toolNames: ['read'],
        },
        {
          role: 'test_designer',
          publicModelId: '',
          instructions: 'Design the checks and cite the evidence each can establish.',
          entryPoints: [],
          skillIds: [skill.id],
          mcpServerIds: [],
          toolNames: ['read'],
        },
      ],
    });
    const role = team.roles.find((item) => item.role === 'test_designer')!;
    expect(role.skills.map((item) => item.id)).toEqual([skill.id]);

    let captured: { systemPrompt: string; builtinTools: Array<{ name: string }> } | undefined;
    gateway.runWorkflowAgent.mockImplementation(async (request: { systemPrompt: string; builtinTools: Array<{ name: string }> }) => {
      captured = request;
      return { text: 'ok' };
    });
    const invocation = new IsolatedAgentInvocationService(
      { publicModelCandidates: async () => [{ provider: {}, model: 'model' }] } as never,
      {} as never,
      { discover: async () => [] } as never,
      { toolDefinitions: (names?: readonly string[]) => (names ?? []).map((name) => ({ name, description: '', inputSchema: { type: 'object' } })) } as never,
    );

    await invocation.execute({
      workspaceId: 'workspace_personal',
      publicModelId: 'public/model',
      systemPrompt: role.instructions,
      context: { goal: 'validate the exam flow' },
      skills: role.skills,
      mcpRuntimes: [],
      builtinToolNames: role.toolNames,
      role: 'test_designer',
      projectDirectory: '/tmp/project',
      signal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toContain('Use `dino-cli account current` before any account command.');
    expect(captured?.systemPrompt).toContain('references/commands.md');
    expect(captured?.systemPrompt).toContain('Skills assigned to this role are already loaded');
  });
});
