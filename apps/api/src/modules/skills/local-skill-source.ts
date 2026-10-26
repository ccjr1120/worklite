import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';

/**
 * A Skill package discovered under the operator's shared Skill directory.
 *
 * The default root is ~/.agents/skills because that is the directory the local
 * agent tooling already uses. Scanning is read-only: WorkLite only copies the
 * package content into its own store and never writes to the source directory.
 */
export type LocalSkillPackage = {
  directory: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  version: string;
  instructions: string;
  files: Array<{ path: string; content: string }>;
  updatedAt: Date;
};

export type LocalSkillSkippedPackage = {
  directory: string;
  reason: string;
};

export type LocalSkillScanResult = {
  root: string;
  available: boolean;
  unavailableReason?: string;
  packages: LocalSkillPackage[];
  skipped: LocalSkillSkippedPackage[];
};

export type SkillFrontmatter = {
  name?: string;
  description?: string;
  version?: string;
  metadata?: Record<string, unknown>;
};

const MAX_SKILL_FILES = 100;
const MAX_SKILL_FILE_BYTES = 256 * 1_024;
const MAX_SKILL_PACKAGE_BYTES = 1 * 1_024 * 1_024;
const MAX_SKILL_PATH_LENGTH = 240;
const MAX_SKILL_DIRECTORY_DEPTH = 8;
const ALLOWED_PACKAGE_ROOTS = new Set(['SKILL.md', 'scripts', 'references']);

export function localSkillRootDirectory(): string {
  const configured = process.env.WORKLITE_LOCAL_SKILLS_DIR?.trim();
  const value = configured || join(homedir(), '.agents', 'skills');
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return resolve(value);
}

/**
 * Stable database id for a package in a workspace. Directory names are the
 * natural package key inside the configured root, so a re-scan finds and
 * updates the same Skill row instead of duplicating it.
 */
export function localSkillId(workspaceId: string, directory: string): string {
  const digest = createHash('sha256').update(workspaceId).update('\0').update(directory).digest('hex');
  return `sk_local_${digest.slice(0, 24)}`;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [{ indent: -1, value: root }];
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    if (/^\t/.test(rawLine)) throw new Error('Skill frontmatter must use spaces for indentation.');
    const indent = rawLine.length - rawLine.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!;
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (!Array.isArray(parent.value)) throw new Error('Skill frontmatter list item has no list parent.');
      parent.value.push(parseScalar(trimmed.slice(1).trim()));
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator <= 0) throw new Error(`Unsupported Skill frontmatter line: ${trimmed}`);
    const key = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`Unsupported Skill frontmatter key: ${key}`);
    if (Array.isArray(parent.value)) throw new Error('Skill frontmatter mappings cannot be nested inside a list.');
    if (/^[|>][+-]?$/.test(rest)) {
      const blockLines: string[] = [];
      let contentIndent: number | undefined;
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor] ?? '';
        if (!line.trim()) {
          blockLines.push('');
          continue;
        }
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent <= indent) break;
        contentIndent ??= lineIndent;
        blockLines.push(line.slice(Math.min(contentIndent, lineIndent)));
      }
      index = cursor - 1;
      parent.value[key] = (rest.startsWith('|') ? blockLines.join('\n') : foldBlockLines(blockLines)).trim();
      continue;
    }
    if (rest) {
      parent.value[key] = parseScalar(rest);
      continue;
    }
    const nextLine = lines.slice(index + 1).find((line) => line.trim() && !line.trimStart().startsWith('#'));
    const nextIndent = nextLine === undefined ? -1 : nextLine.length - nextLine.trimStart().length;
    const nextIsList = nextLine !== undefined && nextIndent > indent && nextLine.trimStart().startsWith('-');
    const child: Record<string, unknown> | unknown[] = nextIsList ? [] : {};
    parent.value[key] = child;
    stack.push({ indent, value: child });
  }

  const rawMetadata = root.metadata;
  if (rawMetadata !== undefined && (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata))) {
    throw new Error('Skill frontmatter metadata must be a mapping.');
  }
  return {
    ...(typeof root.name === 'string' ? { name: root.name } : {}),
    ...(typeof root.description === 'string' ? { description: root.description } : {}),
    ...(typeof root.version === 'string' ? { version: root.version } : typeof root.version === 'number' ? { version: String(root.version) } : {}),
    ...(rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata) ? { metadata: rawMetadata as Record<string, unknown> } : {}),
  };
}

function foldBlockLines(lines: string[]): string {
  return lines.reduce((result, line) => {
    if (!line) return result ? `${result}\n` : result;
    return result && !result.endsWith('\n') ? `${result} ${line}` : `${result}${line}`;
  }, '');
}

function parseScalar(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) return splitInlineList(value.slice(1, -1)).map(parseScalar);
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`Unsupported inline Skill frontmatter mapping: ${value}`);
    }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquote(value);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function splitInlineList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function unquote(value: string): string {
  const quote = value[0]!;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner.replaceAll("''", "'");
  return inner.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

export async function scanLocalSkillRoot(rootDirectory = localSkillRootDirectory()): Promise<LocalSkillScanResult> {
  const root = resolve(rootDirectory);
  let rootReal: string;
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) {
      rootReal = await realpath(root);
    } else if (!stat.isDirectory()) {
      return unavailable(root, 'The configured local Skill root is not a directory.');
    } else {
      rootReal = await realpath(root);
    }
  } catch (error) {
    if (isMissing(error)) {
      return unavailable(root, `The local Skill directory ${root} does not exist. Create it and add Skill packages that contain SKILL.md.`);
    }
    return unavailable(root, `The local Skill directory ${root} cannot be read: ${errorMessage(error)}`);
  }

  let entries;
  try {
    entries = await readdir(rootReal, { withFileTypes: true });
  } catch (error) {
    return unavailable(root, `The local Skill directory ${root} cannot be read: ${errorMessage(error)}`);
  }

  const packages: LocalSkillPackage[] = [];
  const skipped: LocalSkillSkippedPackage[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      skipped.push({ directory: entry.name, reason: 'Symbolic links are not supported as Skill packages.' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      packages.push(await scanPackage(rootReal, entry.name));
    } catch (error) {
      skipped.push({ directory: entry.name, reason: errorMessage(error) });
    }
  }
  return { root, available: true, packages, skipped };
}

async function scanPackage(rootReal: string, directory: string): Promise<LocalSkillPackage> {
  const packageDirectory = join(rootReal, directory);
  const packageReal = await realpath(packageDirectory);
  if (!isInside(rootReal, packageReal)) {
    throw new Error('The Skill package resolves outside the configured local Skill root.');
  }
  const packageStat = await lstat(packageDirectory);
  if (!packageStat.isDirectory()) throw new Error('The Skill package is not a directory.');
  if (packageStat.isSymbolicLink()) throw new Error('Symbolic links are not supported as Skill packages.');

  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const files: Array<{ path: string; content: string }> = [];
  let packageBytes = 0;

  const skillEntry = entries.find((entry) => entry.name === 'SKILL.md');
  if (!skillEntry) throw new Error('The Skill package has no root SKILL.md.');
  if (skillEntry.isSymbolicLink()) throw new Error('Skill package files must not be symbolic links.');
  if (!skillEntry.isFile()) throw new Error('The Skill package SKILL.md must be a regular file.');

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.DS_Store') continue;
    if (entry.name === 'SKILL.md') {
      const content = await readPackageFile(join(packageDirectory, entry.name));
      packageBytes += Buffer.byteLength(content, 'utf8');
      files.push({ path: 'SKILL.md', content });
      continue;
    }
    if (!ALLOWED_PACKAGE_ROOTS.has(entry.name)) {
      throw new Error(`Unsupported Skill package path "${entry.name}". Only SKILL.md, scripts/ and references/ are supported.`);
    }
    if (entry.isSymbolicLink()) throw new Error(`Skill package path "${entry.name}" must not be a symbolic link.`);
    if (!entry.isDirectory()) throw new Error(`Unsupported Skill package path "${entry.name}". Only directories named scripts/ and references/ are supported.`);
    await collectPackageFiles(rootReal, packageDirectory, entry.name, files, { packageBytes });
  }

  files.sort((left, right) => comparePackagePaths(left.path, right.path));
  const instructions = files.find((file) => file.path === 'SKILL.md')?.content ?? '';
  const frontmatter = parseSkillFrontmatter(instructions);
  const name = frontmatter.name?.trim() || directory;
  if (!name) throw new Error('The Skill package has no name.');

  return {
    directory,
    name,
    description: frontmatter.description?.trim() ?? '',
    metadata: frontmatter.metadata ?? {},
    version: frontmatter.version?.trim() || 'local',
    instructions,
    files,
    updatedAt: packageStat.mtime,
  };
}

async function collectPackageFiles(
  rootReal: string,
  packageDirectory: string,
  relativeDirectory: string,
  files: Array<{ path: string; content: string }>,
  state: { packageBytes: number },
  depth = 0,
): Promise<void> {
  if (depth > MAX_SKILL_DIRECTORY_DEPTH) throw new Error(`Skill package directory "${relativeDirectory}" is nested too deeply.`);
  const absoluteDirectory = join(packageDirectory, relativeDirectory);
  const directoryReal = await realpath(absoluteDirectory);
  if (!isInside(rootReal, directoryReal)) throw new Error(`Skill package path "${relativeDirectory}" resolves outside the configured local Skill root.`);
  for (const entry of (await readdir(absoluteDirectory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.DS_Store') continue;
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = join(packageDirectory, relativePath);
    if (entry.isSymbolicLink()) throw new Error(`Skill package path "${relativePath}" must not be a symbolic link.`);
    if (entry.isDirectory()) {
      await collectPackageFiles(rootReal, packageDirectory, relativePath, files, state, depth + 1);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Skill package path "${relativePath}" is not a regular file.`);
    if (relativePath.length > MAX_SKILL_PATH_LENGTH) throw new Error(`Skill package path "${relativePath}" exceeds ${MAX_SKILL_PATH_LENGTH} characters.`);
    if (!relativePath.startsWith('scripts/') && !relativePath.startsWith('references/')) {
      throw new Error(`Unsupported Skill package path "${relativePath}".`);
    }
    const fileReal = await realpath(absolutePath);
    if (!isInside(rootReal, fileReal)) throw new Error(`Skill package path "${relativePath}" resolves outside the configured local Skill root.`);
    const content = await readPackageFile(absolutePath);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SKILL_FILE_BYTES) throw new Error(`Skill package file "${relativePath}" exceeds the 256 KiB text limit.`);
    state.packageBytes += bytes;
    if (files.length + 1 > MAX_SKILL_FILES) throw new Error(`A Skill package cannot contain more than ${MAX_SKILL_FILES} files.`);
    if (state.packageBytes > MAX_SKILL_PACKAGE_BYTES) throw new Error('A Skill package exceeds the 1 MiB text limit.');
    files.push({ path: relativePath, content });
  }
}

async function readPackageFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Skill package file ${path} must not be a symbolic link.`);
  if (!stat.isFile()) throw new Error(`Skill package file ${path} is not a regular file.`);
  if (stat.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill package file ${path} exceeds the 256 KiB text limit.`);
  const content = await readFile(path, 'utf8');
  if (content.includes('\0')) throw new Error(`Skill package file ${path} is not text.`);
  return content;
}

function comparePackagePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

function unavailable(root: string, reason: string): LocalSkillScanResult {
  return { root, available: false, unavailableReason: reason, packages: [], skipped: [] };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
