import { describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({ runWorkflowAgent: vi.fn() }));

vi.mock('@worklite/model-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@worklite/model-gateway')>()),
  createModelGateway: () => ({ runWorkflowAgent: gateway.runWorkflowAgent }),
}));

import { IsolatedAgentInvocationService, structuredSkillFailure } from './isolated-agent-invocation.service';

const tavilySkill = {
  id: 'sk_tavily',
  name: 'tavily-web-research',
  instructions: '# Tavily\nRun scripts/tavily_research.py.',
  files: [{ path: 'scripts/tavily_research.py', content: '#!/usr/bin/env python3\nprint("{}")\n' }],
};

type ToolResult = { type: 'text' | 'error-text'; value: string };

async function runScript(output: string, status: 'succeeded' | 'failed' = 'succeeded', exitCode: number | null = 0) {
  const skillScripts = {
    start: vi.fn(async () => ({ id: 'cmd_1' })),
    wait: vi.fn(async () => ({ execution: { status, exitCode }, output })),
    cancel: vi.fn(async () => undefined),
  };
  const service = new IsolatedAgentInvocationService(
    { publicModelCandidates: async () => [{ provider: { id: 'provider' }, model: 'model' }] } as never,
    skillScripts as never,
    { discover: async () => [] } as never,
    { toolDefinitions: () => [] } as never,
  );
  let toolResult: ToolResult | undefined;
  gateway.runWorkflowAgent.mockImplementation(async (request: { executeTool: (call: unknown) => Promise<ToolResult> }) => {
    toolResult = await request.executeTool({
      toolCallId: 'call_1',
      toolName: 'skill_script',
      input: {},
      skillId: 'sk_tavily',
      scriptPath: 'scripts/tavily_research.py',
      arguments: ['--query', 'x'],
    });
    return { text: 'done' };
  });
  const activities: Array<Record<string, unknown>> = [];
  await service.execute({
    workspaceId: 'workspace_personal',
    publicModelId: 'public/model',
    systemPrompt: 'research',
    context: { topic: 'x' },
    skills: [tavilySkill],
    mcpRuntimes: [],
    builtinToolNames: [],
    signal: new AbortController().signal,
    onSkillScript: (activity) => { activities.push(activity as Record<string, unknown>); },
  });
  return { toolResult, activity: activities[0] };
}

describe('structuredSkillFailure', () => {
  it('returns the reason for an ok:false JSON object and null for anything else', () => {
    expect(structuredSkillFailure('  {"ok":false,"error":"excessive requests"}\n')).toBe('excessive requests');
    expect(structuredSkillFailure('{"ok":false,"error":"rate_limited","message":"excessive requests"}')).toBe('rate_limited: excessive requests');
    expect(structuredSkillFailure('{"ok":false,"hint":"retry later"}')).toBe('retry later');
    expect(structuredSkillFailure('{"ok":false}')).toBe('Skill script reported ok: false.');
    expect(structuredSkillFailure(`{"ok":false,"error":"${'x'.repeat(500)}"}`)?.length).toBe(301);
    expect(structuredSkillFailure('{"ok":true,"results":[]}')).toBeNull();
    expect(structuredSkillFailure('[{"ok":false}]')).toBeNull();
    expect(structuredSkillFailure('Found 3 results.')).toBeNull();
    expect(structuredSkillFailure('{"ok":false, broken')).toBeNull();
    expect(structuredSkillFailure('')).toBeNull();
  });
});

describe('IsolatedAgentInvocationService skill_script outcome', () => {
  it('records an exit-0 script that printed ok:false as failed and returns error-text', async () => {
    const output = '{"ok":false,"error":"excessive requests"}';
    const { toolResult, activity } = await runScript(output);
    expect(activity).toMatchObject({ skillId: 'sk_tavily', exitCode: 0, status: 'failed', failureReason: 'excessive requests' });
    expect(toolResult).toEqual({ type: 'error-text', value: output });
  });

  it('keeps ok:true and plain-text output as succeeded', async () => {
    const okJson = await runScript('{"ok":true,"results":[]}');
    expect(okJson.activity).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(okJson.activity).not.toHaveProperty('failureReason');
    expect(okJson.toolResult?.type).toBe('text');
    const plain = await runScript('Found 3 results.');
    expect(plain.activity).toMatchObject({ status: 'succeeded' });
    expect(plain.toolResult?.type).toBe('text');
  });

  it('adds the structured reason to a process that exited non-zero', async () => {
    const withReason = await runScript('{"ok":false,"error":"missing TAVILY_API_KEY"}', 'failed', 2);
    expect(withReason.activity).toMatchObject({ status: 'failed', exitCode: 2, failureReason: 'missing TAVILY_API_KEY' });
    const withoutReason = await runScript('Traceback ...', 'failed', 1);
    expect(withoutReason.activity).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(withoutReason.activity).not.toHaveProperty('failureReason');
    expect(withoutReason.toolResult?.type).toBe('error-text');
  });
});
