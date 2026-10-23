import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * User-stated aliases for local projects. The metadata scan can only find a project by the
 * names stored in its directory, manifest, remote and README, so a spoken name such as
 * "dino-datahub" may never match a checkout at company/dino/dino-app. This dictionary maps
 * those explicit statements to absolute directories. It is the only file this feature writes.
 */

export const LOCAL_PROJECT_ALIAS_MAX_LENGTH = 120;
export const LOCAL_PROJECT_ALIAS_PATH_MAX_LENGTH = 1_024;
export const LOCAL_PROJECT_ALIAS_NOTE_MAX_LENGTH = 500;

export type LocalProjectAliasRecord = {
  alias: string;
  absolutePath: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalProjectAliasDocument = {
  version: 1;
  aliases: LocalProjectAliasRecord[];
};

export type AliasFileReadResult = {
  aliases: LocalProjectAliasRecord[];
  /** Set when the file exists but could not be parsed; callers degrade to an empty dictionary. */
  error: string | null;
};

export type AliasValidationErrorCode = 'invalid_alias' | 'invalid_path' | 'outside_root' | 'missing_directory';

export class LocalProjectAliasError extends Error {
  constructor(readonly code: AliasValidationErrorCode, message: string) {
    super(message);
    this.name = 'LocalProjectAliasError';
  }
}

export type UpsertAliasInput = {
  alias: string;
  absolutePath: string;
  note?: string | null;
  root: string;
  now?: () => Date;
};

export function aliasKey(alias: string): string {
  return alias.normalize('NFKC').trim().toLowerCase();
}

/** The user's spelling is preserved; surrounding whitespace is not part of the name. */
export function normalizeAlias(alias: string): string {
  if (typeof alias !== 'string') throw new LocalProjectAliasError('invalid_alias', 'alias must be a string.');
  const trimmed = alias.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new LocalProjectAliasError('invalid_alias', 'alias must be a non-empty project name.');
  if (trimmed.length > LOCAL_PROJECT_ALIAS_MAX_LENGTH) {
    throw new LocalProjectAliasError('invalid_alias', `alias must be at most ${LOCAL_PROJECT_ALIAS_MAX_LENGTH} characters.`);
  }
  // Control characters would not survive a URL path or a readable JSON file.
  if ([...trimmed].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  })) {
    throw new LocalProjectAliasError('invalid_alias', 'alias must not contain control characters.');
  }
  return trimmed;
}

export function normalizeAliasNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') throw new LocalProjectAliasError('invalid_alias', 'note must be a string.');
  const trimmed = note.trim();
  if (!trimmed) return null;
  if (trimmed.length > LOCAL_PROJECT_ALIAS_NOTE_MAX_LENGTH) {
    throw new LocalProjectAliasError('invalid_alias', `note must be at most ${LOCAL_PROJECT_ALIAS_NOTE_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Resolves a user-supplied target to an absolute directory. A relative target is read from the
 * project root, so "company/dino/dino-app" means the same checkout as its absolute form.
 * Aliases may point at any existing directory inside the configured root, even outside the
 * scan depth or outside Git; the scan's symlink rule does not apply here.
 */
export function normalizeAliasTarget(rawPath: string, root: string): string {
  if (typeof rawPath !== 'string') throw new LocalProjectAliasError('invalid_path', 'absolutePath must be a string.');
  const trimmed = rawPath.trim();
  if (!trimmed) throw new LocalProjectAliasError('invalid_path', 'absolutePath must be a non-empty directory path.');
  if (trimmed.length > LOCAL_PROJECT_ALIAS_PATH_MAX_LENGTH) {
    throw new LocalProjectAliasError('invalid_path', `absolutePath must be at most ${LOCAL_PROJECT_ALIAS_PATH_MAX_LENGTH} characters.`);
  }

  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, trimmed);
  const within = relative(resolvedRoot, target);
  if (!within || within.startsWith('..') || isAbsolute(within)) {
    throw new LocalProjectAliasError(
      'outside_root',
      `absolutePath must be inside the local project root ${resolvedRoot}; received ${target}.`,
    );
  }

  let stats;
  try {
    stats = statSync(target, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }
  if (!stats?.isDirectory()) {
    throw new LocalProjectAliasError(
      'missing_directory',
      `absolutePath must be an existing directory; ${target} does not exist or is not a directory.`,
    );
  }
  return target;
}

/**
 * Reads the alias dictionary. A missing file is an empty dictionary, and a damaged file is an
 * empty dictionary plus an error string: the query path must never fail because of it, and a
 * later write replaces the damaged file with a valid one.
 */
export function readAliasDocument(path: string): AliasFileReadResult {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return { aliases: [], error: null };
    return { aliases: [], error: `Could not read ${path}: ${errorMessage(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch (error) {
    return { aliases: [], error: `Alias file ${path} is not valid JSON: ${errorMessage(error)}` };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { aliases?: unknown }).aliases)) {
    return { aliases: [], error: `Alias file ${path} must be an object with an "aliases" array.` };
  }

  const aliases: LocalProjectAliasRecord[] = [];
  const seen = new Set<string>();
  for (const entry of (parsed as { aliases: unknown[] }).aliases) {
    const record = parseAliasRecord(entry);
    // A later entry with the same key wins, matching upsert order.
    if (!record) continue;
    const key = aliasKey(record.alias);
    if (seen.has(key)) aliases.splice(aliases.findIndex((item) => aliasKey(item.alias) === key), 1);
    seen.add(key);
    aliases.push(record);
  }
  return { aliases, error: null };
}

function parseAliasRecord(value: unknown): LocalProjectAliasRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.alias !== 'string' || !entry.alias.trim()) return null;
  if (typeof entry.absolutePath !== 'string' || !isAbsolute(entry.absolutePath)) return null;
  const now = new Date().toISOString();
  return {
    alias: entry.alias.trim(),
    absolutePath: resolve(entry.absolutePath),
    note: typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim() : null,
    createdAt: typeof entry.createdAt === 'string' && entry.createdAt ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : now,
  };
}

export function upsertAlias(
  aliases: readonly LocalProjectAliasRecord[],
  input: UpsertAliasInput,
): { aliases: LocalProjectAliasRecord[]; entry: LocalProjectAliasRecord; created: boolean } {
  const alias = normalizeAlias(input.alias);
  const absolutePath = normalizeAliasTarget(input.absolutePath, input.root);
  const note = normalizeAliasNote(input.note);
  const timestamp = (input.now?.() ?? new Date()).toISOString();
  const key = aliasKey(alias);

  const existingIndex = aliases.findIndex((item) => aliasKey(item.alias) === key);
  const created = existingIndex < 0;
  const entry: LocalProjectAliasRecord = created
    ? { alias, absolutePath, note, createdAt: timestamp, updatedAt: timestamp }
    : { ...aliases[existingIndex]!, alias, absolutePath, note, updatedAt: timestamp };
  const next = created
    ? [...aliases, entry]
    : aliases.map((item, index) => (index === existingIndex ? entry : item));
  return { aliases: next, entry, created };
}

export function removeAlias(
  aliases: readonly LocalProjectAliasRecord[],
  alias: string,
): { aliases: LocalProjectAliasRecord[]; removed: LocalProjectAliasRecord | null } {
  const key = aliasKey(normalizeAlias(alias));
  const removed = aliases.find((item) => aliasKey(item.alias) === key) ?? null;
  return {
    aliases: removed ? aliases.filter((item) => aliasKey(item.alias) !== key) : [...aliases],
    removed,
  };
}

export function serializeAliasDocument(aliases: readonly LocalProjectAliasRecord[]): string {
  const document: LocalProjectAliasDocument = { version: 1, aliases: [...aliases] };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Writes the dictionary atomically through a sibling temporary file and rename. */
export function writeAliasDocument(path: string, aliases: readonly LocalProjectAliasRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(temporary, serializeAliasDocument(aliases), 'utf8');
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may already be gone; the original rename error is what matters.
    }
    throw error;
  }
}

export function aliasDirectoryExists(absolutePath: string): boolean {
  try {
    return statSync(absolutePath, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
