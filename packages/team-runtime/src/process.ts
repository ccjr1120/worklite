import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

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

function resolveBmadTeaProcessDirectory(): string {
  const rootCandidate = resolve(process.cwd(), 'packages/team-runtime/processes/bmad-tea');
  const apiCandidate = resolve(process.cwd(), '../../packages/team-runtime/processes/bmad-tea');
  return existsSync(rootCandidate) ? rootCandidate : apiCandidate;
}
export const bmadTeaProcessDirectory = resolveBmadTeaProcessDirectory();
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
