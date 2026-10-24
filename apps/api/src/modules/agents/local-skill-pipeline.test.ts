import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTeams, createDb, initializeDatabase, type Database } from '@worklite/db';
import { WorkspaceResourcesService } from '../teams/team-resources.service';
import { AgentTeamConfigurationService } from '../agent-teams/agent-team-configuration.service';
import { IsolatedAgentInvocationService } from './isolated-agent-invocation.service';
import { localSkillId } from '../skills/local-skill-source';

// Local directory Skills enter the same skills/skill_files rows as imported
// Skills, so this walks the whole supported path: scan -> list -> role capture
// -> runtime prompt and skill_reference.
const gateway = vi.hoisted(() => ({ runWorkflowAgent: vi.fn() }));
vi.mock('@worklite/model-gateway', () => ({
  createModelGateway: () => ({ runWorkflowAgent: gateway.runWorkflowAgent }),
}));

let db: Database | undefined;
let root: string | undefined;
let previousRoot: string | undefined;

afterEach(async () => {
  db?.$client.close();
  db = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  if (previousRoot === undefined) delete process.env.WORKLITE_LOCAL_SKILLS_DIR;
  else process.env.WORKLITE_LOCAL_SKILLS_DIR = previousRoot;
  previousRoot = undefined;
});

const skillMarkdown = `---
name: dino-account
version: 1.2.0
description: "Dino 账号（daily）"
metadata:
  bins: ["dino-cli"]
---

# dino-account

Use \`dino-cli account current\` before any account command.
`;

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'worklite-local-pipeline-'));
  await mkdir(join(root, 'dino-account', 'references'), { recursive: true });
  await writeFile(join(root, 'dino-account', 'SKILL.md'), skillMarkdown);
  await writeFile(join(root, 'dino-account', 'references', 'commands.md'), 'account login -e <email>\n');
  await mkdir(join(root, 'unsupported'), { recursive: true });
  await writeFile(join(root, 'unsupported', 'SKILL.md'), skillMarkdown);
  await mkdir(join(root, 'unsupported', 'assets'), { recursive: true });
  await writeFile(join(root, 'unsupported', 'assets', 'logo.txt'), 'logo');

  previousRoot = process.env.WORKLITE_LOCAL_SKILLS_DIR;
  process.env.WORKLITE_LOCAL_SKILLS_DIR = root;

  const database = createDb(':memory:');
  db = database;
  await initializeDatabase(database);
  database.insert(agentTeams).values({
    id: 'agent_team_bmad_tea',
    workspaceId: 'workspace_personal',
    name: 'Company Project Team',
    description: '',
    processId: 'bmad-tea',
    processVersion: '1',
    roles: [],
  }).run();
  const workspaces = { getWorkspace: async () => ({ id: 'workspace_personal', slug: 'personal', name: 'Personal' }) };
  const resources = new WorkspaceResourcesService(database, workspaces as never, {} as never, {} as never);
  const configuration = new AgentTeamConfigurationService(database, { publicModelRuntime: async () => ({ protocol: 'anthropic/messages' }) } as never);
  return { resources, configuration, root };
}

function role(roleId: string, skillIds: string[]) {
  return {
    role: roleId,
    publicModelId: '',
    instructions: 'Run the checks.',
    entryPoints: [],
    skillIds,
    mcpServerIds: [],
    toolNames: roleId === 'test_runner' ? ['bash', 'read'] : ['read'],
  };
}

describe('Local directory Skill pipeline', () => {
  it('scans into the Skill list, captures a role snapshot and reaches the runtime prompt', async () => {
    const { resources, configuration, root } = await setup();

    const sync = await resources.localSkills({} as Request, 'personal', root);
    expect(sync.available).toBe(true);
    expect(sync.created).toBe(1);
    expect(sync.skipped.map((item) => item.directory)).toEqual(['unsupported']);
    expect(sync.skipped[0]?.reason).toContain('Unsupported Skill package path "assets"');
    const skillId = localSkillId('workspace_personal', 'dino-account');
    expect(sync.synced).toEqual([{ id: skillId, name: 'dino-account', directory: 'dino-account' }]);

    const list = await resources.skills({} as Request, 'personal');
    const local = list.find((skill) => skill.id === skillId);
    expect(local).toMatchObject({
      name: 'dino-account',
      source: 'local',
      version: '1.2.0',
      validation: 'valid',
      description: 'Dino 账号（daily）',
      metadata: { bins: ['dino-cli'] },
    });
    expect(local?.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/commands.md']);

    // A second scan is idempotent.
    const repeated = await resources.localSkills({} as Request, 'personal', root);
    expect(repeated).toMatchObject({ created: 0, updated: 0, unchanged: 1, removed: [] });

    const team = await configuration.update('workspace_personal', 'agent_team_bmad_tea', {
      roles: [
        role('dispatcher', []),
        role('test_designer', []),
        role('test_runner', [skillId]),
      ],
    });
    const testRunner = team.roles.find((item) => item.role === 'test_runner')!;
    expect(testRunner.skills.map((item) => item.id)).toEqual([skillId]);
    expect(testRunner.skills[0]?.instructions).toContain('dino-cli account current');
    expect(testRunner.skills[0]?.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/commands.md']);

    let captured: { systemPrompt: string; builtinTools: Array<{ name: string }>; executeTool: (call: unknown) => Promise<{ type: string; value: string }> } | undefined;
    let referenceResult: { type: string; value: string } | undefined;
    gateway.runWorkflowAgent.mockImplementation(async (request: typeof captured) => {
      captured = request;
      referenceResult = await request!.executeTool({ toolName: 'skill_reference', input: { skillId, path: 'references/commands.md' } });
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
      systemPrompt: testRunner.instructions,
      context: { goal: 'validate the dino exam flow' },
      skills: testRunner.skills,
      mcpRuntimes: [],
      builtinToolNames: testRunner.toolNames,
      role: 'test_runner',
      projectDirectory: '/tmp/project',
      authorizedCommands: [],
      signal: new AbortController().signal,
    });

    expect(captured?.systemPrompt).toContain('Use `dino-cli account current` before any account command.');
    expect(captured?.systemPrompt).toContain('Skills assigned to this role are already loaded');
    expect(captured?.systemPrompt).toContain('references/commands.md');
    expect(captured?.builtinTools.map((tool) => tool.name)).toContain('skill_reference');
    expect(referenceResult).toEqual({ type: 'text', value: expect.stringContaining('account login -e <email>') });
  });

  it('reports an unavailable root and keeps the existing Skill list usable', async () => {
    const { resources } = await setup();
    const missing = join(root!, 'does-not-exist');

    const sync = await resources.localSkills({} as Request, 'personal', missing);

    expect(sync.available).toBe(false);
    expect(sync.skipped).toEqual([]);
    expect(sync.unavailableReason).toContain('does not exist');
    // Listing still works through the configured root instead of failing.
    expect((await resources.skills({} as Request, 'personal')).map((skill) => skill.name)).toContain('dino-account');
  });
});
