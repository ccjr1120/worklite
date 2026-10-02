import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BmadTeaProcessManifest = {
  schemaVersion: number;
  packageId: string;
  description: string;
  transformPolicy: string;
  sources: Record<
    string,
    {
      pathPrefix: string;
      sourcePathPrefix: string;
      repository: string;
      tag: string;
      tagObjectSha: string;
      commitSha: string;
      license: string;
      licensePath: string;
    }
  >;
  files: Array<{
    path: string;
    upstream: string;
    sourcePath: string;
    sha256: string;
  }>;
  entryPoints: Record<string, string[]>;
  deferredEntryPoints: Record<string, string>;
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const bmadTeaProcessDirectory = resolve(moduleDirectory, '../processes/bmad-tea');
const manifestPath = join(bmadTeaProcessDirectory, 'worklite-manifest.json');

export function getBmadTeaProcessManifest(): BmadTeaProcessManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as BmadTeaProcessManifest;
}

export function resolveBmadTeaProcessPath(relativePath: string): string {
  const resolvedPath = resolve(bmadTeaProcessDirectory, relativePath);
  const packageRoot = normalize(bmadTeaProcessDirectory);
  if (resolvedPath !== packageRoot && !resolvedPath.startsWith(`${packageRoot}${join('/')}`)) {
    throw new Error('Process package paths must remain inside the pinned package.');
  }
  return resolvedPath;
}

export async function readBmadTeaProcessFile(relativePath: string): Promise<string> {
  return readFile(resolveBmadTeaProcessPath(relativePath), 'utf8');
}
