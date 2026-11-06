import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentExecutions, agentToolCalls, artifacts, auditLogs, commandExecutions, createDb, initializeDatabase, platformSkillPackageFiles, type Database } from '@worklite/db';
import { AgentExecutionsService } from './agent-executions.service';
import { localImageToolOutput } from './local-image-tool-result';

const image = { id: 'art_image-one', name: '首页截图', mimeType: 'image/png', sizeBytes: 128, width: 3, height: 2,
  contentUrl: '/api/artifacts/art_image-one/content', markdown: '![首页截图](/api/artifacts/art_image-one/content)' };
const evidence = { contract: 'platform-failure/v1', requests: [{ method: 'POST', status: 201, state: 'decoded', pathHash: 'a'.repeat(64), requestId: 'request_images', apiCode: null }] };
const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.$client.close(); });

describe('upload_local_images output contract', () => {
  it.each([false, true])('returns only images after a 201 write, including a captured envelope (%s)', (wrapped) => {
    const wire = wrapped ? { worklite: { type: 'snapshot' }, data: { images: [image] }, workliteEvidence: evidence }
      : { images: [image], workliteEvidence: evidence };
    const stdout = JSON.stringify(wire);
    expect(JSON.parse(localImageToolOutput(stdout)!)).toEqual({ images: [image] });
    expect(JSON.parse(stdout).workliteEvidence).toEqual(evidence);
  });

  it('preserves multiple image URLs, MIME types and sanitized Markdown', () => {
    const second = { ...image, id: 'art_two', mimeType: 'image/jpeg', name: '图片 [2]',
      contentUrl: '/api/artifacts/art_two/content', markdown: '![图片  2](/api/artifacts/art_two/content)' };
    expect(JSON.parse(localImageToolOutput(JSON.stringify({ images: [image, second] }))!)).toEqual({ images: [image, second] });
  });

  it('rejects invalid payloads rather than accepting arbitrary snapshots or ignoring fields', () => {
    const invalid = [null, {}, { images: [] }, { images: Array(9).fill(image) }, { images: [image, image] },
      { worklite: { type: 'snapshot' }, data: {} }, { worklite: { type: 'navigation' }, data: { images: [image] } },
      { images: [image], secretPath: '/private/file.png' }, { images: [{ ...image, objectKey: 'internal' }] },
      ...[{ sizeBytes: 0 }, { sizeBytes: 10 * 1024 * 1024 + 1 }, { width: 100000 }, { width: 8000, height: 8000 },
        { mimeType: 'image/svg+xml' }, { id: '../file' }, { contentUrl: 'file:///private/file.png' }, { markdown: '![image](https://unexpected.test/image.png)' }]
        .map((change) => ({ images: [{ ...image, ...change }], workliteEvidence: evidence })),
    ];
    for (const wire of invalid) expect(localImageToolOutput(JSON.stringify(wire))).toBeNull();
    expect(localImageToolOutput('not JSON')).toBeNull();
  });
});

async function completeScript(scriptPath: string, stdout: string, appliedImage = false) {
  const db = createDb(':memory:'); dbs.push(db); await initializeDatabase(db);
  const skillId = 'sk_worklite_platform';
  const files = platformSkillPackageFiles();
  db.insert(commandExecutions).values({ id: 'command_images', command: 'mocked protected script', cwd: '/tmp', status: 'succeeded', exitCode: 0 }).run();
  db.insert(agentExecutions).values({ id: 'aex_images', workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat', status: 'running', phase: 'skill',
    capabilitySnapshot: { agent: { id: 'agt_system_helper_chat', providerId: null, model: '', systemPrompt: 'Chat' }, skills: [{ id: skillId, name: 'worklite-platform', instructions: '', files }] } as never,
  }).run();
  db.insert(agentToolCalls).values({ id: 'acall_images', toolCallId: 'model_images', executionId: 'aex_images', workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat',
    toolName: 'skill_script', mcpToolName: scriptPath === 'scripts/upload-local-images.mjs' ? 'upload_local_images' : 'other_tool', skillId, scriptPath, packageFiles: files, status: 'running', workingDirectory: '/tmp', arguments: ['{}'],
  }).run();
  const scripts = { start: vi.fn().mockResolvedValue({ id: 'command_images' }), wait: vi.fn().mockImplementation(async () => {
    // The HTTP 201 means the write has already happened before response validation.
    if (appliedImage) db.insert(artifacts).values({ id: image.id, workspaceId: 'workspace_personal', name: image.name, format: 'image', mimeType: image.mimeType }).run();
    return { execution: { id: 'command_images', status: 'succeeded', exitCode: 0 }, stdout, output: stdout };
  }) };
  // Isolate settlement from model generation and channel delivery; run the real
  // executeToolCall/loadExecution path and real database writes/audit updates.
  const service = Object.assign(Object.create(AgentExecutionsService.prototype), { db, skillScripts: scripts, activeMcpRequests: new Map(),
    persistEvent: vi.fn().mockResolvedValue(undefined), publishSnapshotForExecution: vi.fn().mockResolvedValue(undefined), resumeAfterToolCalls: vi.fn().mockResolvedValue(undefined) });
  await service.executeToolCall({} as Request, 'personal', 'workspace_personal', 'agt_system_helper_chat', 'aex_images', 'acall_images');
  return { db, scripts, call: db.select().from(agentToolCalls).where(eq(agentToolCalls.id, 'acall_images')).get()! };
}

describe('protected script response settlement', () => {
  it.each([false, true])('completes an applied upload with an unwrapped result (%s)', async (wrapped) => {
    const stdout = JSON.stringify(wrapped ? { worklite: { type: 'snapshot' }, data: { images: [image] }, workliteEvidence: evidence } : { images: [image], workliteEvidence: evidence });
    const { db, scripts, call } = await completeScript('scripts/upload-local-images.mjs', stdout, true);
    expect(call.status).toBe('completed');
    expect(JSON.parse(call.output)).toEqual({ images: [image] });
    expect(db.select().from(artifacts).all()).toHaveLength(1);
    expect(db.select().from(auditLogs).where(eq(auditLogs.action, 'platform.tool_failure')).all()).toEqual([]);
    expect(scripts.start).toHaveBeenCalledTimes(1);
    expect(scripts.wait).toHaveBeenCalledTimes(1);
  });

  it.each(['scripts/create-agent.mjs', 'scripts/inspect-agent-run.mjs', 'scripts/update-provider-models.mjs'])('preserves the existing contract for %s', async (path) => {
    const wire = path.includes('provider') ? { worklite: { type: 'provider_models', providerId: 'provider' }, data: { providerId: 'provider', models: ['model'] }, workliteEvidence: evidence }
      : { worklite: { type: 'snapshot' }, data: { id: 'result' }, workliteEvidence: evidence };
    const { call } = await completeScript(path, JSON.stringify(wire));
    expect(call.status).toBe('completed');
    expect(JSON.parse(call.output)).toEqual(wire);
  });

  it('does not allow another protected tool to bypass its result contract with image data', async () => {
    const { call, scripts } = await completeScript('scripts/create-agent.mjs', JSON.stringify({ images: [image], workliteEvidence: evidence }));
    expect(call.status).toBe('failed');
    expect(scripts.start).toHaveBeenCalledTimes(1);
  });

  it('still fails an invalid upload payload and never retries an applied write', async () => {
    const stdout = JSON.stringify({ worklite: { type: 'snapshot' }, data: { images: [{ ...image, contentUrl: '/wrong' }] }, workliteEvidence: evidence });
    const { call, scripts } = await completeScript('scripts/upload-local-images.mjs', stdout, true);
    expect(call.status).toBe('failed');
    expect(scripts.start).toHaveBeenCalledTimes(1);
    expect(scripts.wait).toHaveBeenCalledTimes(1);
  });
});
