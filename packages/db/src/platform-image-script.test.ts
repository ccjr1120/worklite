import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { platformSkillPackageFiles } from './client';

// Exercise the actual packaged lib and script with a mocked fetch and process.
// No subprocess, HTTP server, database or local-image registration is needed.
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const files = new Map(platformSkillPackageFiles().map((file) => [file.path, file.content]));

async function runScript(path: string, input: unknown, data: unknown, status = 200) {
  const chunks: string[] = [];
  const process = { env: { WORKLITE_API_URL: 'http://worklite.test/api' }, argv: ['node', path, JSON.stringify(input)], stdout: { write: (chunk: string) => chunks.push(chunk) }, on: vi.fn(), exitCode: 0 };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status }));
  const library = files.get('scripts/lib.mjs')!.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const lib = await new AsyncFunction('process', 'fetch', 'createHash', `${library}\nreturn { call, exactKeys, input, print, requiredString, stringArray };`)(process, fetch, createHash) as Record<string, unknown>;
  const script = files.get(path)!.replace(/^#![^\n]*\n/, '').replace(/^import .*;\n/gm, '');
  await new AsyncFunction(...Object.keys(lib), script)(...Object.values(lib));
  return { fetch, result: JSON.parse(chunks.join('')) as Record<string, unknown> };
}

describe('packaged protected tool result contracts', () => {
  it('forwards a 201 API image result without worklite/data wrapping', async () => {
    const images = [{ id: 'art_one', name: '截图', mimeType: 'image/png', sizeBytes: 10, width: 1, height: 1,
      contentUrl: '/api/artifacts/art_one/content', markdown: '![截图](/api/artifacts/art_one/content)' }];
    const input = { files: [{ path: '/tmp/shot.png', description: '截图' }] };
    const { result, fetch } = await runScript('scripts/upload-local-images.mjs', input, { images }, 201);
    expect(result.images).toEqual(images);
    expect(result).not.toHaveProperty('worklite');
    expect(result).not.toHaveProperty('data');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('http://worklite.test/api/artifacts/local-images');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
  });

  it.each([
    ['scripts/upload-local-files.mjs', { files: [{ path: '/absolute/report.pdf' }] }, { files: [{ id: 'art_file', name: 'report.pdf', contentUrl: '/api/artifacts/art_file/content?download=true' }] }, 'snapshot'],
    ['scripts/create-agent.mjs', { name: 'Agent', responsibility: 'Task', systemPrompt: 'Task' }, { id: 'agent' }, 'snapshot'],
    ['scripts/discover-provider-models.mjs', { providerId: 'provider' }, { models: ['model'] }, 'provider_models'],
    ['scripts/update-provider-models.mjs', { providerId: 'provider', addModels: ['model'] }, { providerId: 'provider', models: ['model'] }, 'provider_models'],
  ] as const)('keeps the intentional shared-library envelope for %s', async (path, input, data, type) => {
    const { result, fetch } = await runScript(path, input, data);
    expect(result.worklite).toMatchObject({ type });
    expect(result.data).toEqual(data);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
