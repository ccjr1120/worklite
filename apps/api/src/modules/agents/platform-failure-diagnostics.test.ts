// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { platformSkillPackageFiles } from '@worklite/db';
import { scriptFailure } from './platform-failure';

describe('platform API validation diagnostics', () => {
  it('preserves a real API rejection through the protected script and failure envelope', () => {
    const source = platformSkillPackageFiles().find((file) => file.path === 'scripts/lib.mjs')!.content;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const message = 'Each sub-Agent must exist and belong to exactly one parent.';
    const script = `
      globalThis.fetch = async () => new Response(JSON.stringify({ statusCode: 400, message: ${JSON.stringify(message)}, privateValue: 'do-not-copy-response-body' }), { status: 400 });
      const lib = await import(${JSON.stringify(moduleUrl)});
      await lib.call('/agents/parent/sub-agents/child', { method: 'DELETE', body: { privateValue: 'do-not-copy-request-body' } });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, WORKLITE_API_URL: 'http://unused.invalid/api' }, encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(child.stdout).not.toContain('do-not-copy');
    expect(JSON.parse(child.stdout)).toMatchObject({ workliteFailure: { requests: [{ method: 'DELETE', status: 400, message }] } });
    expect(scriptFailure(child.stdout)).toMatchObject({ stage: 'api', code: 'PLATFORM_API_INPUT_INVALID', evidence: { requests: [{ status: 400, message }] } });
  });
});
