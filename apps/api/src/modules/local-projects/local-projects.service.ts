import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_SCAN_OPTIONS,
  scanLocalProjects,
  searchProjectRecords,
  type AliasCandidate,
  type LocalProjectIndex,
  type LocalProjectSearchResult,
} from './local-projects';
import {
  LocalProjectAliasError,
  aliasDirectoryExists,
  readAliasDocument,
  removeAlias as removeAliasEntry,
  upsertAlias,
  writeAliasDocument,
  type LocalProjectAliasRecord,
} from './local-project-aliases';

const DEFAULT_INDEX_TTL_MS = 10 * 60 * 1000;
// A Chat turn waits for a first scan, so the scan must stay well inside a normal tool timeout.
const DEFAULT_SCAN_TIMEOUT_MS = 4_000;
const MIN_BACKGROUND_REFRESH_INTERVAL_MS = 60 * 1000;

export type LocalProjectAliasView = LocalProjectAliasRecord & { missing: boolean };

export type LocalProjectAliasList = {
  path: string;
  total: number;
  count: number;
  aliases: LocalProjectAliasView[];
  /** Set when the alias file exists but is damaged; the list is then empty. */
  error: string | null;
};

export type LocalProjectSearchResponse = LocalProjectSearchResult & {
  root: string;
  indexPath: string;
  aliasesPath: string;
  aliasCount: number;
  aliasFileError: string | null;
  updatedAt: string | null;
  scanDurationMs: number;
  stale: boolean;
  timedOut: boolean;
  truncated: boolean;
  partial: boolean;
  refreshRunning: boolean;
  note: string | null;
};

@Injectable()
export class LocalProjectsService {
  private readonly logger = new Logger(LocalProjectsService.name);
  private cached: LocalProjectIndex | null = null;
  private diskLoaded = false;
  private inFlight: Promise<LocalProjectIndex> | null = null;
  private backgroundRefreshRunning = false;
  private lastScanAttemptAt = 0;
  private lastAliasFileError: string | null = null;
  private aliasWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  /** Agent-private lookup uses the same index as Chat, plus filesystem metadata checks only. */
  async searchForAgent(input: unknown) {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.trim().length > 200) throw new BadRequestException('query must be a non-empty string of at most 200 characters.');
    if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw new BadRequestException('limit must be an integer from 1 to 50.');
    if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new BadRequestException('refresh must be a boolean.');
    const query = args.query.trim();
    const checkDirectory = async (absolutePath: string) => {
      try {
        return { absolutePath, directoryStatus: (await stat(absolutePath)).isDirectory() ? 'exists' as const : 'not_directory' as const };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { absolutePath, directoryStatus: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' as const : 'unknown' as const, errorCode: code ?? 'UNKNOWN' };
      }
    };
    const result = await this.search(query, { limit: args.limit as number | undefined, refresh: args.refresh as boolean | undefined });
    const verify = async (candidate: LocalProjectSearchResponse['results'][number]) => ({ ...candidate, ...await checkDirectory(candidate.absolutePath) });
    const [results, approximate, requestedDirectory] = await Promise.all([
      Promise.all(result.results.map(verify)),
      Promise.all(result.approximate.map(verify)),
      isAbsolute(query) ? checkDirectory(query) : Promise.resolve(null),
    ]);
    return {
      ...result, results, approximate, requestedDirectory,
      lookupStatus: results.length ? 'matched' : 'not_indexed',
      note: [result.note, 'No index match does not prove a project does not exist. Use only directories with directoryStatus=exists; approximate candidates are suggestions, not matches. missing applies only to the checked path; unknown means the path could not be checked.'].filter(Boolean).join(' '),
    };
  }

  async search(query: string, options: { limit?: number; refresh?: boolean } = {}): Promise<LocalProjectSearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) throw new BadRequestException('query must be a non-empty project name or keyword.');
    if (trimmed.length > 200) throw new BadRequestException('query must be at most 200 characters.');

    let index = options.refresh ? await this.cachedIndex() : await this.currentIndex();
    let timedOut = index?.timedOut ?? false;
    let refreshDeferred = false;

    if (options.refresh) {
      const scanned = await this.runScan();
      timedOut = scanned.timedOut;
      if (!scanned.complete && index?.complete) {
        // Keep the last complete index instead of replacing it with a partial scan; the caller
        // still learns that this refresh timed out.
        refreshDeferred = true;
      } else {
        index = scanned;
      }
    } else if (!index) {
      index = await this.runScan();
      timedOut = index.timedOut;
    } else if (this.isStale(index)) {
      this.refreshInBackground();
    }

    const aliasState = this.readAliases();
    const result = searchProjectRecords(index?.projects ?? [], trimmed, options.limit ?? 10, {
      aliases: aliasState.candidates,
      root: this.rootPath(),
    });
    const stale = index ? this.isStale(index) : true;
    return {
      ...result,
      root: this.rootPath(),
      indexPath: this.indexPath(),
      aliasesPath: this.aliasesPath(),
      aliasCount: aliasState.aliases.length,
      aliasFileError: aliasState.error,
      updatedAt: index?.scannedAt ?? null,
      scanDurationMs: index?.durationMs ?? 0,
      stale,
      timedOut,
      truncated: index?.truncated ?? false,
      partial: index ? !index.complete : true,
      refreshRunning: this.backgroundRefreshRunning || this.inFlight !== null,
      note: this.noteFor(index, refreshDeferred, timedOut),
    };
  }

  async listAliases(rawQuery?: string): Promise<LocalProjectAliasList> {
    const { aliases, error } = this.readAliasFile();
    const query = (rawQuery ?? '').trim().toLowerCase();
    const views = aliases
      .map((entry) => ({ ...entry, missing: !aliasDirectoryExists(entry.absolutePath) }))
      .filter((entry) => !query || [entry.alias, entry.absolutePath, entry.note ?? '']
        .some((value) => value.toLowerCase().includes(query)));
    return { path: this.aliasesPath(), total: aliases.length, count: views.length, aliases: views, error };
  }

  async setAlias(input: { alias?: unknown; absolutePath?: unknown; note?: unknown }): Promise<{
    path: string;
    created: boolean;
    alias: LocalProjectAliasView;
  }> {
    try {
      return await this.withAliasWrite(() => {
        const path = this.aliasesPath();
        const { aliases, error } = this.readAliasFile();
        const { aliases: next, entry, created } = upsertAlias(aliases, {
          alias: input.alias as string,
          absolutePath: input.absolutePath as string,
          note: input.note as string | null | undefined,
          root: this.rootPath(),
        });
        writeAliasDocument(path, next);
        if (error) this.logger.warn(`Replaced the damaged alias file at ${path} while saving "${entry.alias}".`);
        return { path, created, alias: { ...entry, missing: false } };
      });
    } catch (error) {
      throw this.aliasApiError(error);
    }
  }

  async removeAlias(alias: string): Promise<{ path: string; deleted: true; alias: string; entry: LocalProjectAliasRecord }> {
    try {
      const result = await this.withAliasWrite(() => {
        const path = this.aliasesPath();
        const { aliases } = this.readAliasFile();
        const { aliases: next, removed } = removeAliasEntry(aliases, alias);
        if (!removed) return { path, removed: null as LocalProjectAliasRecord | null };
        writeAliasDocument(path, next);
        return { path, removed };
      });
      if (!result.removed) throw new NotFoundException(`No saved alias matches "${alias}".`);
      return { path: result.path, deleted: true, alias: result.removed.alias, entry: result.removed };
    } catch (error) {
      throw this.aliasApiError(error);
    }
  }

  private aliasApiError(error: unknown): unknown {
    if (error instanceof LocalProjectAliasError) return new BadRequestException(error.message);
    return error;
  }

  private async withAliasWrite<T>(action: () => T): Promise<T> {
    // Serialize read-modify-write cycles so two tool calls cannot drop one another's entry.
    const run = this.aliasWriteQueue.then(action, action);
    this.aliasWriteQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private readAliasFile(): { aliases: LocalProjectAliasRecord[]; error: string | null } {
    const { aliases, error } = readAliasDocument(this.aliasesPath());
    if (error) {
      if (error !== this.lastAliasFileError) this.logger.warn(`Local project aliases degraded to an empty dictionary: ${error}`);
      this.lastAliasFileError = error;
    } else {
      this.lastAliasFileError = null;
    }
    return { aliases, error };
  }

  private readAliases(): { aliases: LocalProjectAliasRecord[]; candidates: AliasCandidate[]; error: string | null } {
    const { aliases, error } = this.readAliasFile();
    return {
      aliases,
      error,
      candidates: aliases.map((entry) => ({
        alias: entry.alias,
        absolutePath: entry.absolutePath,
        note: entry.note,
        missing: !aliasDirectoryExists(entry.absolutePath),
      })),
    };
  }

  async status(): Promise<{ root: string; indexPath: string; aliasesPath: string; aliasCount: number; aliasFileError: string | null; indexedProjects: number; updatedAt: string | null; complete: boolean; timedOut: boolean; truncated: boolean; scanDurationMs: number; error: string | null }> {
    const index = await this.currentIndex();
    const aliases = this.readAliasFile();
    return {
      root: this.rootPath(),
      indexPath: this.indexPath(),
      aliasesPath: this.aliasesPath(),
      aliasCount: aliases.aliases.length,
      aliasFileError: aliases.error,
      indexedProjects: index?.projects.length ?? 0,
      updatedAt: index?.scannedAt ?? null,
      complete: index?.complete ?? false,
      timedOut: index?.timedOut ?? false,
      truncated: index?.truncated ?? false,
      scanDurationMs: index?.durationMs ?? 0,
      error: index?.error ?? null,
    };
  }

  private async cachedIndex(): Promise<LocalProjectIndex | null> {
    if (this.cached) return this.cached;
    if (!this.diskLoaded) {
      this.diskLoaded = true;
      this.cached = await this.readIndex();
    }
    return this.cached;
  }

  private async currentIndex(): Promise<LocalProjectIndex | null> {
    const cached = await this.cachedIndex();
    if (cached) return cached;
    this.cached = await this.runScan();
    return this.cached;
  }

  private async runScan(): Promise<LocalProjectIndex> {
    if (this.inFlight) return this.inFlight;
    this.lastScanAttemptAt = Date.now();
    const scanning = (async (): Promise<LocalProjectIndex> => {
      const scan = scanLocalProjects({
        root: this.rootPath(),
        maxDepth: this.numberSetting('WORKLITE_LOCAL_PROJECTS_MAX_DEPTH', DEFAULT_SCAN_OPTIONS.maxDepth, 1, 12),
        timeoutMs: this.numberSetting('WORKLITE_LOCAL_PROJECTS_SCAN_TIMEOUT_MS', DEFAULT_SCAN_TIMEOUT_MS, 100, 60_000),
        maxDirectories: this.numberSetting('WORKLITE_LOCAL_PROJECTS_MAX_DIRECTORIES', DEFAULT_SCAN_OPTIONS.maxDirectories, 1, 1_000_000),
        maxRepositories: this.numberSetting('WORKLITE_LOCAL_PROJECTS_MAX_REPOSITORIES', DEFAULT_SCAN_OPTIONS.maxRepositories, 1, 100_000),
      });
      if (scan.complete || !this.cached?.complete) {
        this.cached = scan;
        await this.writeIndex(scan);
      }
      if (scan.timedOut || scan.truncated) {
        this.logger.warn(`Local project scan was incomplete: timedOut=${scan.timedOut} truncated=${scan.truncated} directories=${scan.directoriesVisited} projects=${scan.projects.length}.`);
      }
      return scan;
    })();
    this.inFlight = scanning;
    try {
      return await scanning;
    } finally {
      if (this.inFlight === scanning) this.inFlight = null;
    }
  }

  private refreshInBackground(): void {
    if (this.backgroundRefreshRunning || this.inFlight) return;
    if (Date.now() - this.lastScanAttemptAt < MIN_BACKGROUND_REFRESH_INTERVAL_MS) return;
    this.backgroundRefreshRunning = true;
    void this.runScan()
      .catch((error: unknown) => this.logger.warn(`Background local project refresh failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.backgroundRefreshRunning = false; });
  }

  private isStale(index: LocalProjectIndex): boolean {
    if (!index.complete) return true;
    const updatedAt = Date.parse(index.scannedAt);
    if (!Number.isFinite(updatedAt)) return true;
    return Date.now() - updatedAt > this.numberSetting('WORKLITE_LOCAL_PROJECTS_INDEX_TTL_MS', DEFAULT_INDEX_TTL_MS, 0, 30 * 24 * 60 * 60 * 1000);
  }

  private noteFor(index: LocalProjectIndex | null, refreshDeferred: boolean, timedOut: boolean): string | null {
    if (refreshDeferred) return '索引刷新超时，本次返回上一版完整索引；稍后重试 refresh 可获取最新结果。';
    if (!index) return '尚未建立项目索引。';
    if (index.error) return index.error;
    if (timedOut || index.timedOut) return '索引扫描超时，结果为部分项目；可用 refresh 重试。';
    if (index.truncated) return '索引达到扫描上限，结果为部分项目。';
    if (!index.complete) return '索引不完整，结果可能缺失部分项目。';
    return null;
  }

  private rootPath(): string {
    const configured = this.config.get<string>('WORKLITE_LOCAL_PROJECTS_ROOT')?.trim();
    return resolve(configured || join(homedir(), 'development'));
  }

  private indexPath(): string {
    const configured = this.config.get<string>('WORKLITE_LOCAL_PROJECTS_INDEX_PATH')?.trim();
    if (configured) return resolve(configured);
    // Match the runtime's shared persistent directory first, then the database location.
    const dataDirectory = this.config.get<string>('WORKLITE_DATA_DIRECTORY')?.trim();
    if (dataDirectory) return join(resolve(dataDirectory), 'local-projects.json');
    const sqlitePath = this.config.get<string>('SQLITE_PATH')?.trim();
    const databaseDirectory = !sqlitePath || sqlitePath === ':memory:'
      ? resolve('../../.data/deployment')
      : dirname(resolve(sqlitePath));
    return join(databaseDirectory, 'local-projects.json');
  }

  private aliasesPath(): string {
    const configured = this.config.get<string>('WORKLITE_LOCAL_PROJECTS_ALIASES_PATH')?.trim();
    if (configured) return resolve(configured);
    // The alias dictionary lives next to the index cache in the runtime data directory.
    return join(dirname(this.indexPath()), 'local-project-aliases.json');
  }

  private async readIndex(): Promise<LocalProjectIndex | null> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath(), 'utf8')) as LocalProjectIndex;
      if (parsed.version !== 1 || parsed.root !== this.rootPath() || !Array.isArray(parsed.projects)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeIndex(index: LocalProjectIndex): Promise<void> {
    const path = this.indexPath();
    try {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8');
      await rename(temporary, path);
    } catch (error) {
      this.logger.warn(`Could not persist the local project index at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private numberSetting(key: string, fallback: number, minimum: number, maximum: number): number {
    const raw = this.config.get<string>(key)?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      this.logger.warn(`${key}=${raw} is outside ${minimum}..${maximum}; using ${fallback}.`);
      return fallback;
    }
    return value;
  }
}
