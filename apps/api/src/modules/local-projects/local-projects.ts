import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Metadata-only index of local projects. The scanner never reads source files: for each Git
 * checkout it reads the .git marker, HEAD, remote origin config, root-level manifest name and
 * the README title/first paragraph. This keeps Chat able to resolve a project path without
 * gaining repository read access.
 */

export const LOCAL_PROJECT_CATEGORIES = ['company', 'self', 'temp', 'forks', 'other'] as const;
export type LocalProjectCategory = (typeof LOCAL_PROJECT_CATEGORIES)[number];

export const DEFAULT_SCAN_OPTIONS = {
  maxDepth: 3,
  timeoutMs: 4_000,
  maxDirectories: 20_000,
  maxRepositories: 2_000,
} as const;

const NOISE_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', '.next', '.nuxt', '.output',
  '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache', 'coverage', '.idea', '.vscode',
]);
const MANIFEST_FILE_LIMIT = 512 * 1024;
const README_FILE_LIMIT = 64 * 1024;
const GIT_METADATA_FILE_LIMIT = 256 * 1024;
const MAX_DESCRIPTION_CHARS = 300;

export type LocalProjectRecord = {
  absolutePath: string;
  relativePath: string;
  directoryName: string;
  repositoryName: string;
  displayName: string;
  description: string;
  readmeTitle: string | null;
  category: LocalProjectCategory;
  gitRemoteUrl: string | null;
  branch: string | null;
  isMainWorktree: boolean;
  workspacePatterns: string[];
};

export type LocalProjectIndex = {
  version: 1;
  root: string;
  scannedAt: string;
  durationMs: number;
  complete: boolean;
  timedOut: boolean;
  truncated: boolean;
  directoriesVisited: number;
  error: string | null;
  projects: LocalProjectRecord[];
};

export type LocalProjectMatch = LocalProjectRecord & {
  score: number;
  matchReasons: string[];
  /** Whether this entry came from a user-stated alias or from scanned project metadata. */
  matchedVia: 'alias' | 'metadata';
  /** True when an alias matched but its stored directory no longer exists. */
  missing: boolean;
  /** Alias note, or a stale-path instruction when the alias target is missing. */
  note: string | null;
  /** The alias that produced this entry, when matchedVia is "alias". */
  alias: string | null;
};

/** One user-stated alias, already checked against the filesystem by the caller. */
export type AliasCandidate = {
  alias: string;
  absolutePath: string;
  note: string | null;
  missing: boolean;
};

export type ProjectSearchOptions = {
  aliases?: readonly AliasCandidate[];
  /** Root used to infer category and relativePath for aliases outside the indexed set. */
  root?: string;
};

export type LocalProjectSearchResult = {
  query: string;
  limit: number;
  results: LocalProjectMatch[];
  approximate: LocalProjectMatch[];
  totalMatched: number;
  indexedProjects: number;
};

export type ScanOptions = {
  root: string;
  maxDepth?: number;
  timeoutMs?: number;
  maxDirectories?: number;
  maxRepositories?: number;
  now?: () => number;
};

export function classifyProject(root: string, directory: string): LocalProjectCategory {
  const path = relative(resolve(root), resolve(directory));
  if (!path || path === '.' || path.startsWith('..')) return 'other';
  const [first] = path.split(sep);
  return (LOCAL_PROJECT_CATEGORIES as readonly string[]).includes(first as LocalProjectCategory)
    ? first as LocalProjectCategory
    : 'other';
}

export function scanLocalProjects(options: ScanOptions): LocalProjectIndex {
  const root = resolve(options.root);
  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_OPTIONS.maxDepth;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_OPTIONS.timeoutMs;
  const maxDirectories = options.maxDirectories ?? DEFAULT_SCAN_OPTIONS.maxDirectories;
  const maxRepositories = options.maxRepositories ?? DEFAULT_SCAN_OPTIONS.maxRepositories;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const projects: LocalProjectRecord[] = [];
  let directoriesVisited = 0;
  let timedOut = false;
  let truncated = false;

  const rootStats = safeLstat(root);
  if (!rootStats?.isDirectory()) {
    return {
      version: 1, root, scannedAt: new Date().toISOString(), durationMs: 0,
      complete: false, timedOut: false, truncated: false, directoriesVisited: 0,
      error: `Project root is not a readable directory: ${root}`, projects: [],
    };
  }

  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    if (now() - startedAt >= timeoutMs) { timedOut = true; break; }
    if (directoriesVisited >= maxDirectories) { truncated = true; break; }

    const { directory, depth } = queue.shift()!;
    directoriesVisited += 1;

    const record = readProjectRecord(root, directory);
    if (record) {
      if (projects.length >= maxRepositories) { truncated = true; break; }
      projects.push(record);
    }
    if (depth >= maxDepth) continue;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (NOISE_DIRECTORIES.has(entry.name)) continue;
      queue.push({ directory: join(directory, entry.name), depth: depth + 1 });
    }
  }

  projects.sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
  return {
    version: 1,
    root,
    scannedAt: new Date().toISOString(),
    durationMs: now() - startedAt,
    complete: !timedOut && !truncated,
    timedOut,
    truncated,
    directoriesVisited,
    error: null,
    projects,
  };
}

function readProjectRecord(root: string, directory: string): LocalProjectRecord | null {
  const git = readGitMetadata(directory);
  if (!git) return null;
  const directoryName = basename(directory);
  const manifest = readManifest(directory);
  const readme = readReadme(directory);
  const description = (manifest.description || readme.summary || '').slice(0, MAX_DESCRIPTION_CHARS);
  return {
    absolutePath: directory,
    relativePath: relative(root, directory) || '.',
    directoryName,
    repositoryName: repositoryNameFromRemote(git.remoteUrl) ?? directoryName,
    displayName: manifest.name || readme.title || directoryName,
    description,
    readmeTitle: readme.title,
    category: classifyProject(root, directory),
    gitRemoteUrl: git.remoteUrl,
    branch: git.branch,
    isMainWorktree: git.isMainWorktree,
    workspacePatterns: manifest.workspacePatterns,
  };
}

type GitMetadata = { remoteUrl: string | null; branch: string | null; isMainWorktree: boolean };

function readGitMetadata(directory: string): GitMetadata | null {
  const marker = safeLstat(join(directory, '.git'));
  if (!marker) return null;

  let gitDirectory: string;
  let isMainWorktree: boolean;
  if (marker.isDirectory()) {
    gitDirectory = join(directory, '.git');
    isMainWorktree = true;
  } else if (marker.isFile()) {
    const pointer = readFileLimited(join(directory, '.git'), 4 * 1024);
    const match = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer);
    if (!match) return null;
    gitDirectory = resolve(directory, match[1]!.trim());
    isMainWorktree = false;
  } else {
    return null;
  }

  const head = readFileLimited(join(gitDirectory, 'HEAD'), 4 * 1024);
  const branch = head === null ? null : parseHead(head);

  // Linked worktrees and submodules keep most Git state in a common directory (commondir).
  const commonDirectoryFile = readFileLimited(join(gitDirectory, 'commondir'), 4 * 1024);
  const commonDirectory = commonDirectoryFile
    ? resolve(gitDirectory, commonDirectoryFile.trim())
    : gitDirectory;
  const config = readFileLimited(join(commonDirectory, 'config'), GIT_METADATA_FILE_LIMIT);
  const remoteUrl = config === null ? null : parseOriginUrl(config);

  return { remoteUrl, branch, isMainWorktree };
}

/** Removes embedded credentials (for example oauth2 tokens) from a Git remote URL. */
export function sanitizeRemoteUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i.exec(trimmed);
  if (withScheme) return `${withScheme[1]}${trimmed.slice(withScheme[0].length)}`;
  const scpLike = /^([^/@]+)@([^/:]+:.+)$/.exec(trimmed);
  // Keep a plain git@host:owner/repo remote; strip only userinfo that carries a password or token.
  return scpLike && scpLike[1]!.includes(':') ? scpLike[2]! : trimmed;
}

function parseHead(content: string): string | null {
  const line = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line);
  if (ref) return ref[1]!.trim();
  if (/^ref:\s*\S+/.test(line)) return line.slice('ref: '.length).replace(/^refs\//, '');
  return /^[0-9a-f]{7,40}$/i.test(line) ? line.slice(0, 12) : null;
}

function parseOriginUrl(config: string): string | null {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(trimmed);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/i.exec(trimmed);
    if (match) return sanitizeRemoteUrl(match[1]!);
  }
  return null;
}

export function repositoryNameFromRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const cleaned = remoteUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!cleaned) return null;
  const name = cleaned.split(/[/:]/).filter(Boolean).pop();
  return name || null;
}

function readManifest(directory: string): { name: string | null; description: string | null; workspacePatterns: string[] } {
  const empty = { name: null, description: null, workspacePatterns: [] as string[] };
  const packageJson = readFileLimited(join(directory, 'package.json'), MANIFEST_FILE_LIMIT);
  if (packageJson) {
    try {
      const parsed = JSON.parse(stripBom(packageJson)) as Record<string, unknown>;
      const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null;
      const description = typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : null;
      const workspaces = parsed.workspaces;
      const workspacePatterns = Array.isArray(workspaces)
        ? workspaces.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: unknown }).packages)
          ? ((workspaces as { packages: unknown[] }).packages).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
      return { name, description, workspacePatterns };
    } catch {
      // A malformed package.json still identifies a project through Git metadata.
    }
  }

  const pyproject = readFileLimited(join(directory, 'pyproject.toml'), MANIFEST_FILE_LIMIT);
  const pyprojectName = pyproject === null ? null : /^\s*name\s*=\s*"([^"]+)"/m.exec(
    (/\[project\][\s\S]*?(?=\n\[|$)/.exec(pyproject) ?? /\[tool\.poetry\][\s\S]*?(?=\n\[|$)/.exec(pyproject) ?? [''])[0],
  )?.[1] ?? null;
  if (pyprojectName) return { ...empty, name: pyprojectName };

  const goMod = readFileLimited(join(directory, 'go.mod'), MANIFEST_FILE_LIMIT);
  const goName = goMod === null ? null : /^module\s+(\S+)/m.exec(goMod)?.[1] ?? null;
  if (goName) return { ...empty, name: goName };

  const cargo = readFileLimited(join(directory, 'Cargo.toml'), MANIFEST_FILE_LIMIT);
  const cargoName = cargo === null ? null : /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? null;
  if (cargoName) return { ...empty, name: cargoName };

  const pom = readFileLimited(join(directory, 'pom.xml'), MANIFEST_FILE_LIMIT);
  const pomName = pom === null ? null : /<artifactId>\s*([^<]+?)\s*<\/artifactId>/i.exec(pom)?.[1] ?? null;
  return pomName ? { ...empty, name: pomName } : empty;
}

function readReadme(directory: string): { title: string | null; summary: string | null } {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return { title: null, summary: null };
  }
  const candidates = entries
    .filter((entry) => /^readme(\.[a-z0-9]+)?$/i.test(entry))
    .sort((left, right) => readmeRank(left) - readmeRank(right));
  const fileName = candidates[0];
  if (!fileName) return { title: null, summary: null };

  const content = readFileLimited(join(directory, fileName), README_FILE_LIMIT);
  if (content === null) return { title: null, summary: null };
  const lines = stripBom(content).replace(/\r\n?/g, '\n').split('\n');
  let title: string | null = null;
  const paragraph: string[] = [];
  let started = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!title) {
      const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
      if (heading) { title = cleanReadmeText(heading[1]!); continue; }
    }
    if (!line) {
      if (started && paragraph.length > 0) break;
      continue;
    }
    if (!started && isReadmeNoise(line)) continue;
    if (/^#{1,6}\s+/.test(line) || /^[-=]{3,}$/.test(line)) continue;
    started = true;
    paragraph.push(line);
  }
  const summary = paragraph.length > 0 ? cleanReadmeText(paragraph.join(' ').slice(0, MAX_DESCRIPTION_CHARS)) : null;
  return { title, summary: summary || null };
}

function readmeRank(fileName: string): number {
  const lower = fileName.toLowerCase();
  if (lower === 'readme.md') return 0;
  if (lower === 'readme.markdown') return 1;
  if (lower === 'readme.txt') return 2;
  return 3;
}

function isReadmeNoise(line: string): boolean {
  return /^<[^>]+>$/.test(line)
    || /^!\[[^\]]*\]\([^)]*\)$/.test(line)
    || /^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)$/.test(line)
    || /^<!--/.test(line);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function cleanReadmeText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeLstat(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/** Reads a regular file without following symlinks or exceeding the byte budget. */
function readFileLimited(path: string, maxBytes: number): string | null {
  const stats = safeLstat(path);
  if (!stats?.isFile() || stats.size > maxBytes) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const KIND_SCORE = { exact: 1000, prefix: 700, word: 550, substring: 400 } as const;
type MatchKind = keyof typeof KIND_SCORE;

// Primary identity fields rank above descriptive text and paths, so a directory substring
// match always outranks a description hit.
const SEARCH_FIELDS: Array<{ key: keyof LocalProjectRecord; label: string; weight: number }> = [
  { key: 'directoryName', label: 'directoryName', weight: 1 },
  { key: 'repositoryName', label: 'repositoryName', weight: 1 },
  { key: 'displayName', label: 'displayName', weight: 0.98 },
  { key: 'readmeTitle', label: 'readmeTitle', weight: 0.9 },
  { key: 'gitRemoteUrl', label: 'gitRemoteUrl', weight: 0.35 },
  { key: 'description', label: 'description', weight: 0.3 },
  { key: 'relativePath', label: 'relativePath', weight: 0.2 },
];

export function searchProjectRecords(
  projects: readonly LocalProjectRecord[],
  rawQuery: string,
  rawLimit = 10,
  options: ProjectSearchOptions = {},
): LocalProjectSearchResult {
  const query = rawQuery.trim();
  const limit = Math.max(1, Math.min(50, Math.trunc(Number.isFinite(rawLimit) ? rawLimit : 10)));
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return { query, limit, results: [], approximate: [], totalMatched: 0, indexedProjects: projects.length };
  }

  const root = resolve(options.root ?? process.cwd());
  const matches: LocalProjectMatch[] = [];
  for (const project of projects) {
    const reasons: string[] = [];
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const best = bestFieldMatch(project, token) ?? segmentFieldMatch(project, token);
      if (!best) { matchedAll = false; break; }
      score += best.score;
      reasons.push(best.reason ?? `${best.label}: ${best.kind} match "${token}"`);
    }
    if (!matchedAll) continue;
    matches.push(metadataMatch(project, Math.round(score), reasons));
  }

  // Alias matches outrank every metadata field, so a spoken name resolves to the directory the
  // user explicitly mapped it to.
  const aliasMatches = matchAliases(projects, options.aliases ?? [], query, tokens, root);
  const merged = mergeMatches(matches, aliasMatches);
  merged.sort(compareMatches);

  const results = merged.slice(0, limit);
  const approximate = results.length === 0
    ? approximateMatches(projects, tokens, Math.min(5, limit), options.aliases ?? [], root)
    : [];
  return { query, limit, results, approximate, totalMatched: merged.length, indexedProjects: projects.length };
}

function metadataMatch(project: LocalProjectRecord, score: number, reasons: readonly string[]): LocalProjectMatch {
  return {
    ...project,
    score,
    matchReasons: [...new Set(reasons)],
    matchedVia: 'metadata',
    missing: false,
    note: null,
    alias: null,
  };
}

// Exact alias equality scores above the 1000 exact-metadata tier; every fuzzy alias tier also
// stays above the highest metadata score so an alias always wins over ordinary fields.
const ALIAS_SCORE = { exact: 2000, prefix: 1700, word: 1500, substring: 1200 } as const;
const KIND_RANK: Record<MatchKind, number> = { exact: 3, prefix: 2, word: 1, substring: 0 };

function matchAliases(
  projects: readonly LocalProjectRecord[],
  aliases: readonly AliasCandidate[],
  rawQuery: string,
  tokens: readonly string[],
  root: string,
): LocalProjectMatch[] {
  if (aliases.length === 0) return [];
  const byPath = new Map(projects.map((project) => [resolve(project.absolutePath), project] as const));
  const normalizedQuery = normalizeText(rawQuery);
  const matches: LocalProjectMatch[] = [];

  for (const alias of aliases) {
    const aliasText = normalizeText(alias.alias);
    if (!aliasText) continue;
    const kind = aliasMatchKind(aliasText, normalizedQuery, tokens);
    if (!kind) continue;

    const absolutePath = resolve(alias.absolutePath);
    const base = byPath.get(absolutePath) ?? syntheticAliasRecord(root, absolutePath);
    const reasons = [`alias: "${alias.alias}"`, `alias: ${kind} match "${rawQuery.trim()}"`];
    if (alias.missing) reasons.push(`path missing: ${absolutePath}`);
    matches.push({
      ...base,
      score: ALIAS_SCORE[kind],
      matchReasons: [...new Set(reasons)],
      matchedVia: 'alias',
      missing: alias.missing,
      note: aliasResultNote(alias),
      alias: alias.alias,
    });
  }
  return matches;
}

function aliasMatchKind(aliasText: string, normalizedQuery: string, tokens: readonly string[]): MatchKind | null {
  if (aliasText === normalizedQuery) return 'exact';
  if (tokens.length === 0) return null;
  let weakest: MatchKind | null = null;
  for (const token of tokens) {
    const kind = matchKind(aliasText, token);
    if (!kind) return null;
    if (!weakest || KIND_RANK[kind] < KIND_RANK[weakest]) weakest = kind;
  }
  return weakest;
}

function aliasResultNote(alias: AliasCandidate): string | null {
  if (!alias.missing) return alias.note;
  const suffix = alias.note ? ` Note: ${alias.note}` : '';
  return `Alias "${alias.alias}" points to a directory that no longer exists: ${alias.absolutePath}. Tell the user this path is stale.${suffix}`;
}

/** An alias may target a directory the scan did not index, including a non-Git directory. */
function syntheticAliasRecord(root: string, absolutePath: string): LocalProjectRecord {
  const relativePath = relative(root, absolutePath);
  const outsideRoot = !relativePath || relativePath.startsWith('..') || isAbsolute(relativePath);
  const directoryName = basename(absolutePath) || absolutePath;
  return {
    absolutePath,
    relativePath: outsideRoot ? absolutePath : relativePath,
    directoryName,
    repositoryName: directoryName,
    displayName: directoryName,
    description: '',
    readmeTitle: null,
    category: classifyProject(root, absolutePath),
    gitRemoteUrl: null,
    branch: null,
    isMainWorktree: false,
    workspacePatterns: [],
  };
}

/**
 * Keeps one entry per absolutePath. An alias entry wins because it explains why the path was
 * returned, while metadata reasons are merged in so both sources stay visible.
 */
function mergeMatches(primary: readonly LocalProjectMatch[], secondary: readonly LocalProjectMatch[]): LocalProjectMatch[] {
  const byPath = new Map<string, LocalProjectMatch>();
  const put = (match: LocalProjectMatch): void => {
    const key = resolve(match.absolutePath);
    const existing = byPath.get(key);
    if (!existing) { byPath.set(key, match); return; }
    const alias = existing.matchedVia === 'alias' ? existing : match.matchedVia === 'alias' ? match : null;
    const other = alias === existing ? match : existing;
    const winner = alias ?? (existing.score >= match.score ? existing : match);
    byPath.set(key, {
      ...winner,
      score: Math.max(existing.score, match.score),
      matchReasons: [...new Set([...(alias?.matchReasons ?? []), ...other.matchReasons])],
      matchedVia: alias ? 'alias' : winner.matchedVia,
      missing: alias?.missing ?? winner.missing,
      note: alias?.note ?? winner.note,
      alias: alias?.alias ?? winner.alias,
    });
  };
  for (const match of primary) put(match);
  for (const match of secondary) put(match);
  return [...byPath.values()];
}

type FieldMatch = { score: number; kind: MatchKind; label: string; reason?: string };

function bestFieldMatch(project: LocalProjectRecord, token: string): FieldMatch | null {
  let best: FieldMatch | null = null;
  for (const field of SEARCH_FIELDS) {
    const value = project[field.key];
    if (typeof value !== 'string' || !value) continue;
    const kind = matchKind(value, token);
    if (!kind) continue;
    const score = KIND_SCORE[kind] * field.weight;
    if (!best || score > best.score) best = { score, kind, label: field.label };
  }
  return best;
}

/**
 * A guessed compound name such as "dino-datahub" may not exist as one directory while both of
 * its segments identify a real repository (parent org "dino", repository "apex-datahub").
 * Segment matching runs only when the whole token matches nothing.
 */
function segmentFieldMatch(project: LocalProjectRecord, token: string): FieldMatch | null {
  const segments = [...new Set(token.split(/[-_.\s/]+/).filter((part) => part.length >= 2))];
  if (segments.length < 2) return null;
  let total = 0;
  for (const segment of segments) {
    const best = bestFieldMatch(project, segment);
    if (!best) return null;
    total += best.score;
  }
  // Averaging keeps a guessed compound below a direct prefix or word match.
  return {
    score: (total / segments.length) * 0.8,
    kind: 'substring',
    label: 'segments',
    reason: `segments: ${segments.join(' + ')}`,
  };
}

function matchKind(value: string, token: string): MatchKind | null {
  const text = normalizeText(value);
  if (!text) return null;
  if (text === token) return 'exact';
  if (text.startsWith(token)) return 'prefix';
  if (wordSet(value).has(token)) return 'word';
  if (text.includes(token)) return 'substring';
  return null;
}

function wordSet(value: string): Set<string> {
  const words = new Set<string>();
  for (const part of normalizeText(value).split(/[^a-z0-9㐀-鿿]+/)) {
    if (part) words.add(part);
  }
  for (const part of value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9㐀-鿿]+/)) {
    if (part) words.add(part);
  }
  return words;
}

function approximateMatches(
  projects: readonly LocalProjectRecord[],
  tokens: readonly string[],
  limit: number,
  aliases: readonly AliasCandidate[] = [],
  root = process.cwd(),
): LocalProjectMatch[] {
  const compactQuery = tokens.join('');
  const cjkQuery = cjkCharacters(compactQuery);
  const byPath = new Map(projects.map((project) => [resolve(project.absolutePath), project] as const));

  const scored: LocalProjectMatch[] = [];
  for (const project of projects) {
    const partial = partialTokenScore(tokens, (token) => bestFieldMatch(project, token));
    const hit = partial ?? scoreApproximate([project.directoryName, project.repositoryName, project.displayName, project.readmeTitle ?? '', project.description], compactQuery, cjkQuery);
    if (hit) scored.push(metadataMatch(project, Math.round(hit.score), hit.reasons));
  }

  const aliasScored: LocalProjectMatch[] = [];
  for (const alias of aliases) {
    const absolutePath = resolve(alias.absolutePath);
    const base = byPath.get(absolutePath) ?? syntheticAliasRecord(root, absolutePath);
    const partial = partialTokenScore(tokens, (token) => {
      const kind = matchKind(alias.alias, token);
      return kind ? { score: KIND_SCORE[kind], label: 'alias' } : null;
    });
    const hit = partial ?? scoreApproximate([alias.alias, base.directoryName, base.repositoryName, base.displayName, base.description], compactQuery, cjkQuery);
    if (!hit) continue;
    const reasons = [`alias: "${alias.alias}"`, ...hit.reasons];
    if (alias.missing) reasons.push(`path missing: ${absolutePath}`);
    aliasScored.push({
      ...base,
      score: Math.round(hit.score),
      matchReasons: [...new Set(reasons)],
      matchedVia: 'alias',
      missing: alias.missing,
      note: aliasResultNote(alias),
      alias: alias.alias,
    });
  }

  return mergeMatches(scored, aliasScored).sort(compareMatches).slice(0, limit);
}

function partialTokenScore(
  tokens: readonly string[],
  lookup: (token: string) => { score: number; label: string } | null,
): { score: number; reasons: string[] } | null {
  const reasons: string[] = [];
  let score = 0;
  for (const token of tokens) {
    const best = lookup(token);
    if (!best) continue;
    score += best.score / tokens.length;
    reasons.push(`${best.label}: partial "${token}"`);
  }
  return score > 0 ? { score, reasons } : null;
}

function scoreApproximate(fields: readonly string[], compactQuery: string, cjkQuery: readonly string[]): { score: number; reasons: string[] } | null {
  const similarity = Math.max(...fields.map((field) => bigramSimilarity(compactQuery, normalizeText(field))));
  const cjkOverlap = cjkQuery.length >= 2
    ? Math.max(...fields.map((field) => cjkCharacterOverlap(cjkQuery, field)))
    : 0;
  if (cjkOverlap >= 0.5) {
    // Chinese keywords often appear as one part of a phrase; character overlap keeps a
    // meaningful partial hit visible without relaxing Latin matching.
    return { score: cjkOverlap * 300, reasons: [`partial keyword overlap ${Math.round(cjkOverlap * 100)}%`] };
  }
  if (similarity >= 0.45 && compactQuery.length >= 3) {
    return { score: similarity * 300, reasons: [`approximate similarity ${Math.round(similarity * 100)}%`] };
  }
  return null;
}

function cjkCharacters(value: string): string[] {
  return [...value].filter((char) => /[㐀-鿿]/.test(char));
}

function cjkCharacterOverlap(queryCharacters: readonly string[], field: string): number {
  const present = new Set(cjkCharacters(field));
  const matched = queryCharacters.filter((char) => present.has(char)).length;
  return queryCharacters.length === 0 ? 0 : matched / queryCharacters.length;
}

function bigramSimilarity(left: string, right: string): number {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const bigram of leftBigrams) counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  let overlap = 0;
  for (const bigram of rightBigrams) {
    const count = counts.get(bigram) ?? 0;
    if (count === 0) continue;
    overlap += 1;
    counts.set(bigram, count - 1);
  }
  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value: string): string[] {
  const characters = [...value];
  const result: string[] = [];
  for (let index = 0; index < characters.length - 1; index += 1) result.push(characters[index]! + characters[index + 1]!);
  return result;
}

function compareMatches(left: LocalProjectMatch, right: LocalProjectMatch): number {
  if (right.score !== left.score) return right.score - left.score;
  // Among equally strong prefix matches, the name closest to the query is the better answer.
  if (left.directoryName.length !== right.directoryName.length) return left.directoryName.length - right.directoryName.length;
  return left.absolutePath.localeCompare(right.absolutePath);
}

export function tokenize(query: string): string[] {
  return [...new Set(normalizeText(query).split(/[\s,，、;；/\\|]+/).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}
