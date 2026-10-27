import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  ArtifactDetailView,
  ArtifactListPageView,
  ArtifactListQuery,
  AuditEventView,
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
  CreateModelProviderRequest,
  CreateSkillRequest,
  CommandExecutionView,
  DeleteMcpServerResult,
  DeleteSkillResult,
  ExecuteSkillScriptRequest,
  ImportSkillRequest,
  McpServerReferenceReport,
  McpServerTestResult,
  McpServerView,
  ModelProviderView,
  ModelProviderProtocol,
  SkillView,
  SkillConflictView,
  SkillReferenceCleanup,
  UpdateModelProviderRequest,
  UpdateWorkspaceSettingsRequest,
  UsageRow,
  WorkspaceSettingsView,
} from '@worklite/contracts';
import { GATEWAY_STATS_GROUP_BYS, GATEWAY_SURFACES, WORKLITE_PLATFORM_SKILL_NAME } from '@worklite/contracts';
import {
  agentExecutions,
  agentMcpServers,
  agentTeams,
  agentTeamVersions,
  artifacts,
  agentSkills,
  agents,
  auditLogs,
  chatConfigurations,
  mcpServers,
  modelProviders,
  platformSkillPackageFiles,
  skillFiles,
  skills,
  skillIdAliases,
  workflowDrafts,
  workflowEditRevisions,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
  wechatOfficialAccounts,
  workflows,
  workspaceSettings,
  type Database,
  type StoredAgentTeamRoleConfiguration,
  type StoredAgentTeamSkillSnapshot,
  type StoredWorkflowDefinition,
} from '@worklite/db';
import { normalizePublicModelList, type ModelCandidate, type ModelProviderConfig } from '@worklite/model-gateway';
import { listWorkflowNodeCapabilities } from '@worklite/workflow-engine';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from './teams.service';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import {
  localSkillId,
  localSkillRootDirectory,
  parseSkillFrontmatter,
  platformSkillRootDirectory,
  scanLocalSkillRoot,
  scanLocalSkillRoots,
  skillDirectoryName,
  skillRootDirectory,
  type LocalSkillPackage,
  type SkillRootKind,
} from '../skills/local-skill-source';
import { McpClientService } from '../mcp-servers/mcp-client.service';
import { getArtifactDetail, listArtifacts } from '../artifacts/artifacts-query';
import { ArtifactStorageService } from '../artifacts/artifact-storage.service';
import { AGENT_TEAM_ROLES, BUILT_IN_AGENT_TEAM_ID } from '../agent-teams/agent-team-configuration';
import { isWorkliteNavigationTarget, resolveWorkliteNavigationRoute } from './worklite-navigation';

function maskSecret(value: string): string {
  return value.length > 4 ? `****${value.slice(-4)}` : '****';
}

/**
 * The legacy API provider table stores only the protocols its own rows may hold.
 * Credential-forwarding protocols belong to the Gateway store, so this guard both
 * rejects them and narrows the value to what the column accepts.
 */
type StoredModelProviderProtocol = typeof modelProviders.$inferSelect['protocol'];

function isStoredProtocol(protocol: ModelProviderProtocol): protocol is StoredModelProviderProtocol {
  return protocol === 'openai/chat' || protocol === 'openai/responses' || protocol === 'anthropic/messages' || protocol === 'codex/responses';
}

function encryptSecret(value: string): string {
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(value: string): string {
  const [ivValue, tagValue, encryptedValue] = value.split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw new Error('Invalid encrypted secret');
  const key = createHash('sha256').update(process.env.SECRET_ENCRYPTION_KEY ?? 'worklite-development-secret').digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
}

function normalizeHeaders(input: Record<string, string> | undefined): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Custom headers must be a JSON object.');
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.trim();
    if (!name || typeof value !== 'string') throw new BadRequestException('Custom header names and values must be non-empty strings.');
    headers[name] = value;
  }
  return headers;
}

function headerNames(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decryptSecret(value)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}

function storedSecret(value: string | null): string {
  if (!value) return '';
  // A rotated SECRET_ENCRYPTION_KEY leaves rows this process cannot decrypt.
  // Reading one must not fail the response, matching the Gateway registry.
  try { return decryptSecret(value); } catch { return ''; }
}

function providerView(row: typeof modelProviders.$inferSelect): ModelProviderView {
  return { id: row.id, name: row.name, baseURL: row.baseURL, protocol: row.protocol, status: row.status, apiKey: storedSecret(row.apiKey), maskedKey: row.maskedKey, models: row.models ?? [], headerNames: headerNames(row.headers) };
}

function mcpServerView(row: typeof mcpServers.$inferSelect, workspaceSlug: string): McpServerView {
  return { id: row.id, workspaceSlug, name: row.name, endpoint: row.endpoint, connection: row.connection, connectionError: row.connectionError ?? null, transport: 'Streamable HTTP', allowedTools: row.allowedTools, allowedToolNames: row.allowedToolNames ?? [], version: row.version, updatedAt: row.updatedAt.toISOString() };
}

function normalizeToolNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new BadRequestException('Allowed MCP tools must be an array of tool names.');
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function classifyMcpFailure(error: unknown): Pick<McpServerTestResult, 'connection' | 'error'> {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const code = typeof candidate?.code === 'number' ? candidate.code : undefined;
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';
  if (name === 'UnauthorizedError' || code === 401 || code === 403) return { connection: 'auth_failed', error: 'authentication' };
  if (message.includes('protocol version') || message.includes('method not found')) return { connection: 'unreachable', error: 'unsupported_protocol' };
  if (message.includes('invalid') || message.includes('parse')) return { connection: 'unreachable', error: 'malformed_response' };
  return { connection: 'unreachable', error: 'unreachable' };
}

type PackageFile = { path: string; content: string };

export type AgentMcpRuntime = {
  id: string;
  name: string;
  endpoint: string;
  authToken?: string;
  allowedTools: string[];
};

const MAX_SKILL_FILES = 100;
const MAX_SKILL_FILE_BYTES = 256 * 1_024;
const MAX_SKILL_PACKAGE_BYTES = 1 * 1_024 * 1_024;

const GATEWAY_PROVIDER_ID = 'gateway-provider';
const GATEWAY_PORT = Number(process.env.PORTKEY_GATEWAY_PORT ?? 23392);
const GATEWAY_ATTRIBUTION_FILTERS = ['surface', 'conversationId', 'projectTaskId', 'executor', 'teamId', 'teamRunId', 'workflowId', 'workflowRunId'] as const;
const GATEWAY_PROVIDER_URL = `http://127.0.0.1:${GATEWAY_PORT}/worklite/providers`;

function validatePackageFiles(input: unknown): PackageFile[] {
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestException('A Skill package must contain SKILL.md.');
  if (input.length > MAX_SKILL_FILES) throw new BadRequestException(`A Skill package cannot contain more than ${MAX_SKILL_FILES} files.`);
  const paths = new Set<string>();
  let packageBytes = 0;
  const files = input.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Every Skill package file must include a path and text content.');
    const path: string = 'path' in value && typeof value.path === 'string' ? value.path.trim() : '';
    const content: string | null = 'content' in value && typeof value.content === 'string' ? value.content : null;
    const allowedRoot = path === 'SKILL.md' || path.startsWith('scripts/') || path.startsWith('references/');
    const segments = path.split('/');
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || segments.some((segment) => !segment || segment === '.' || segment === '..') || !allowedRoot) {
      throw new BadRequestException('Skill file paths must be relative POSIX paths under scripts/ or references/, or the root SKILL.md.');
    }
    if (path.length > 240) throw new BadRequestException('A Skill file path cannot exceed 240 characters.');
    if (paths.has(path)) throw new BadRequestException(`Duplicate Skill file path: ${path}`);
    if (content === null) throw new BadRequestException(`Skill file ${path} must contain text content.`);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SKILL_FILE_BYTES) throw new BadRequestException(`Skill file ${path} exceeds the 256 KiB text limit.`);
    paths.add(path);
    packageBytes += bytes;
    return { path, content };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!paths.has('SKILL.md')) throw new BadRequestException('A Skill package must contain SKILL.md.');
  if (packageBytes > MAX_SKILL_PACKAGE_BYTES) throw new BadRequestException('A Skill package exceeds the 1 MiB text limit.');
  return files;
}

function skillView(row: typeof skills.$inferSelect, workspaceSlug: string, files: PackageFile[], conflict?: SkillConflictView): SkillView {
  const frontmatter = skillFrontmatter(files);
  return {
    id: row.id,
    workspaceSlug,
    name: row.name,
    source: 'local',
    root: row.root,
    rootPath: skillRootDirectory(row.root),
    directory: row.directory,
    version: row.version,
    validation: row.validation,
    ...(row.validationReason ? { validationReason: row.validationReason } : {}),
    ...(conflict ? { conflict } : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.metadata ? { metadata: frontmatter.metadata } : {}),
    files,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function skillFrontmatter(files: PackageFile[]): ReturnType<typeof parseSkillFrontmatter> {
  const skillFile = files.find((file) => file.path === 'SKILL.md');
  if (!skillFile) return {};
  try {
    return parseSkillFrontmatter(skillFile.content);
  } catch {
    // A malformed frontmatter must not hide an otherwise readable Skill.
    return {};
  }
}

function samePackageFiles(left: PackageFile[], right: PackageFile[]): boolean {
  return left.length === right.length && left.every((file, index) => file.path === right[index]?.path && file.content === right[index]?.content);
}

function isSafePackagePath(path: string): boolean {
  const allowedRoot = path === 'SKILL.md' || path.startsWith('scripts/') || path.startsWith('references/');
  const segments = path.split('/');
  return Boolean(path) && path.length <= 240 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..') && allowedRoot;
}

function storedPackageFiles(files: PackageFile[], row: typeof skills.$inferSelect): PackageFile[] {
  const byPath = new Map<string, PackageFile>();
  for (const file of files) {
    if (!isSafePackagePath(file.path)) throw new Error(`Legacy Skill ${row.name} contains unsupported path ${file.path}.`);
    byPath.set(file.path, { path: file.path, content: file.content });
  }
  if (!byPath.has('SKILL.md')) byPath.set('SKILL.md', { path: 'SKILL.md', content: row.instructions || `# ${row.name}\n` });
  const result = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const bytes = result.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
  if (result.length > MAX_SKILL_FILES || bytes > MAX_SKILL_PACKAGE_BYTES) throw new Error(`Legacy Skill ${row.name} exceeds the Skill package limits.`);
  return result;
}

function suffixDirectory(base: string, index: number): string {
  if (index === 1) return base;
  const suffix = `-${index}`;
  return `${base.slice(0, Math.max(1, 240 - suffix.length))}${suffix}`;
}

function skillDirectoryPath(root: SkillRootKind, directory: string): string {
  if (!directory || directory === '.' || directory === '..' || directory.includes('/') || directory.includes('\\') || directory.includes('\0')) {
    throw new Error('The stored Skill directory is not a single package directory name.');
  }
  const rootDirectory = resolve(skillRootDirectory(root));
  const target = resolve(rootDirectory, directory);
  const path = relative(rootDirectory, target);
  if (path !== directory || path.startsWith(`..${sep}`) || path === '..') throw new Error('The stored Skill directory escapes its configured root.');
  return target;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function emptySkillCleanup(): SkillReferenceCleanup {
  return { agentIds: [], chatConfigurationRevisions: [], workflowDrafts: [], agentTeamRoles: [], agentTeamDeveloperInstances: [] };
}

function mapSkillIds(ids: readonly string[], mapping: ReadonlyMap<string, string>, remove = false): string[] {
  return [...new Set(ids.flatMap((id) => {
    const mapped = mapping.get(id);
    if (remove) return mapped ? [] : [id];
    return [mapped ?? id];
  }))];
}

function workflowSkillNodeIds(definition: StoredWorkflowDefinition, ids: ReadonlySet<string>): string[] {
  return definition.nodes.flatMap((node) => {
    if (node.type !== 'worklite/agent' || !node.config || typeof node.config !== 'object' || Array.isArray(node.config)) return [];
    const skillIds = (node.config as Record<string, unknown>).skillIds;
    return Array.isArray(skillIds) && skillIds.some((id) => typeof id === 'string' && ids.has(id)) ? [node.id] : [];
  });
}

function rewriteWorkflowSkillIds(definition: StoredWorkflowDefinition, mapping: ReadonlyMap<string, string>, remove = false): StoredWorkflowDefinition | null {
  let changed = false;
  const nodes = definition.nodes.map((node) => {
    if (node.type !== 'worklite/agent' || !node.config || typeof node.config !== 'object' || Array.isArray(node.config)) return node;
    const config = node.config as Record<string, unknown>;
    if (!Array.isArray(config.skillIds) || config.skillIds.some((id) => typeof id !== 'string')) return node;
    const nextIds = mapSkillIds(config.skillIds, mapping, remove);
    if (sameStringList(config.skillIds, nextIds)) return node;
    changed = true;
    return { ...node, config: { ...config, skillIds: nextIds } };
  });
  return changed ? { ...definition, nodes } : null;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function skillNameKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US');
}

function previousLocalSkillId(workspaceId: string, directory: string): string {
  const digest = createHash('sha256').update(workspaceId).update('\0').update(directory).digest('hex');
  return `sk_local_${digest.slice(0, 24)}`;
}

function rewriteRoleSkillIds(
  role: StoredAgentTeamRoleConfiguration,
  mapping: ReadonlyMap<string, string>,
  remove = false,
  currentSnapshots: ReadonlyMap<string, StoredAgentTeamSkillSnapshot> = new Map(),
): StoredAgentTeamRoleConfiguration | null {
  let changed = false;
  const rewrite = (skill: StoredAgentTeamSkillSnapshot): StoredAgentTeamSkillSnapshot[] => {
    if (remove && mapping.has(skill.id)) {
      changed = true;
      return [];
    }
    const id = mapping.get(skill.id) ?? skill.id;
    const mapped = id === skill.id ? skill : { ...skill, id };
    if (id !== skill.id) changed = true;
    const current = currentSnapshots.get(id);
    if (!current) {
      if (mapped !== skill) changed = true;
      return [mapped];
    }
    if (JSON.stringify(mapped) === JSON.stringify(current)) return [mapped];
    changed = true;
    return [{ ...current }];
  };
  const skills = role.skills.flatMap(rewrite);
  const developerInstances = role.developerInstances?.map((instance) => {
    let instanceChanged = false;
    const instanceSkills = instance.skills.flatMap((skill) => {
      const rewritten = rewrite(skill);
      if (rewritten.length !== 1 || JSON.stringify(rewritten[0]) !== JSON.stringify(skill)) instanceChanged = true;
      return rewritten;
    });
    if (!instanceChanged) return instance;
    changed = true;
    return { ...instance, skills: instanceSkills };
  });
  if (!changed) return null;
  return { ...role, skills, ...(developerInstances ? { developerInstances } : {}) };
}

async function writeSkillDirectory(rootDirectory: string, directory: string, files: PackageFile[]): Promise<'created' | 'exists'> {
  await mkdir(rootDirectory, { recursive: true });
  const target = join(rootDirectory, directory);
  try {
    await stat(target);
    return 'exists';
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const temporary = await mkdtemp(join(rootDirectory, '.skill-write-'));
  try {
    for (const file of files) {
      const path = join(temporary, ...file.path.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, 'utf8');
    }
    await rename(temporary, target);
    return 'created';
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (typeof error === 'object' && error !== null && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes(String((error as { code?: unknown }).code))) return 'exists';
    throw error;
  }
}

function providerHeaders(value: string | null): Record<string, string> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(decryptSecret(value)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((headerValue) => typeof headerValue !== 'string')) {
    throw new Error('Invalid stored headers');
  }
  return parsed as Record<string, string>;
}

function providerConfig(row: typeof modelProviders.$inferSelect, apiKey: string): ModelProviderConfig {
  const common = { id: row.id, apiKey, baseURL: row.baseURL ?? undefined, headers: providerHeaders(row.headers) };
  if (row.protocol === 'anthropic/messages') return { ...common, adapter: 'anthropic', operation: 'messages' };
  if (row.protocol === 'codex/responses') return { ...common, adapter: 'codex', operation: 'responses' };
  if (row.protocol === 'openai/responses') return { ...common, adapter: 'openai', operation: 'responses' };
  if (row.protocol === 'openai/chat') return { ...common, adapter: 'openai', operation: 'chat/completions' };
  throw new BadRequestException('Unsupported model provider protocol.');
}

const CHAT_AGENT_ID = 'agt_system_helper_chat';

type SkillSyncResult = {
  conflicts: Map<string, SkillConflictView>;
};

@Injectable()
export class WorkspaceResourcesService {
  private readonly logger = new Logger(WorkspaceResourcesService.name);
  private readonly localSkillSyncs = new Map<string, Promise<SkillSyncResult>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly skillScripts: SkillScriptRunnerService,
    private readonly mcpClient: McpClientService,
    private readonly artifactStorage: ArtifactStorageService,
  ) {}

  /** Reconcile the two local roots for callers that only have a workspace id. */
  async reconcileWorkspaceSkills(workspaceId: string): Promise<void> {
    await this.syncLocalSkills(workspaceId);
  }

  async resolveSkillIds(workspaceId: string, skillIds: readonly string[]): Promise<string[]> {
    await this.syncLocalSkills(workspaceId);
    if (skillIds.length === 0) return [];
    const aliases = await this.db.select({ oldSkillId: skillIdAliases.oldSkillId, currentSkillId: skillIdAliases.currentSkillId })
      .from(skillIdAliases).where(eq(skillIdAliases.workspaceId, workspaceId));
    const mapping = new Map(aliases.map((alias) => [alias.oldSkillId, alias.currentSkillId]));
    return [...new Set(skillIds.map((skillId) => {
      let current = skillId;
      const visited = new Set<string>();
      while (mapping.has(current) && !visited.has(current)) {
        visited.add(current);
        const next = mapping.get(current)!;
        if (next === current) break;
        current = next;
      }
      return current;
    }))];
  }

  private async syncLocalSkills(workspaceId: string): Promise<SkillSyncResult> {
    const inFlight = this.localSkillSyncs.get(workspaceId);
    if (inFlight) return inFlight;
    const promise = this.performLocalSkillSync(workspaceId).finally(() => this.localSkillSyncs.delete(workspaceId));
    this.localSkillSyncs.set(workspaceId, promise);
    return promise;
  }

  private async performLocalSkillSync(workspaceId: string): Promise<SkillSyncResult> {
    const initialScan = await scanLocalSkillRoots();
    const unavailable = initialScan.roots.find((root) => !root.available && !root.rootMissing);
    if (unavailable) throw new ServiceUnavailableException(unavailable.unavailableReason ?? `Skill root ${unavailable.root} is unavailable.`);
    await this.ensurePlatformSkillPackage(workspaceId);
    const legacyMigrations = await this.migrateLegacySkills(workspaceId);
    const scan = await scanLocalSkillRoots();
    const unavailableAfterMigration = scan.roots.find((root) => !root.available && !root.rootMissing);
    if (unavailableAfterMigration) throw new ServiceUnavailableException(unavailableAfterMigration.unavailableReason ?? `Skill root ${unavailableAfterMigration.root} is unavailable.`);

    const existingRows = await this.db.select().from(skills).where(eq(skills.workspaceId, workspaceId));
    const existingFiles = existingRows.length === 0
      ? []
      : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, existingRows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    const filesBySkill = new Map<string, PackageFile[]>();
    for (const file of existingFiles) filesBySkill.set(file.skillId, [...(filesBySkill.get(file.skillId) ?? []), { path: file.path, content: file.content }]);
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    const desired = new Map<string, { directory: string; root: SkillRootKind; package?: LocalSkillPackage; invalidReason?: string }>();
    for (const skillPackage of scan.packages) desired.set(`${skillPackage.root}\0${skillPackage.directory}`, { directory: skillPackage.directory, root: skillPackage.root, package: skillPackage });
    for (const skipped of scan.skipped) {
      const key = `${skipped.root}\0${skipped.directory}`;
      if (!desired.has(key)) desired.set(key, { directory: skipped.directory, root: skipped.root, invalidReason: skipped.reason });
    }
    const platformCoreDirectory = skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME);
    const platformRootScan = scan.roots.find((root) => root.kind === 'platform');
    const platformCorePackage = platformRootScan?.packages.find((skillPackage) => skillPackage.directory === platformCoreDirectory);
    const platformCoreSkipped = platformRootScan?.skipped.find((item) => item.directory === platformCoreDirectory);
    if (platformCorePackage) desired.set(`platform\0${platformCoreDirectory}`, { directory: platformCoreDirectory, root: 'platform', package: platformCorePackage });
    else if (platformCoreSkipped) desired.set(`platform\0${platformCoreDirectory}`, { directory: platformCoreDirectory, root: 'platform', invalidReason: platformCoreSkipped.reason });

    for (const item of desired.values()) {
      const id = localSkillId(workspaceId, item.directory, item.root);
      const existing = existingById.get(id);
      const existingPackage = filesBySkill.get(id) ?? [];
      if (item.package) {
        const skillPackage = item.package;
        const changed = !existing
          || existing.name !== skillPackage.name
          || existing.root !== skillPackage.root
          || existing.directory !== skillPackage.directory
          || existing.instructions !== skillPackage.instructions
          || existing.version !== skillPackage.version
          || existing.validation !== 'valid'
          || existing.validationReason !== null
          || !samePackageFiles(existingPackage, skillPackage.files);
        if (!existing) {
          await this.db.transaction((transaction) => {
            transaction.insert(skills).values({
              id,
              workspaceId,
              name: skillPackage.name,
              source: 'local',
              root: skillPackage.root,
              directory: skillPackage.directory,
              version: skillPackage.version,
              validation: 'valid',
              validationReason: null,
              instructions: skillPackage.instructions,
              updatedAt: skillPackage.updatedAt,
            }).run();
            transaction.insert(skillFiles).values(skillPackage.files.map((file) => ({ skillId: id, ...file }))).run();
          });
        } else if (changed) {
          await this.db.transaction((transaction) => {
            transaction.update(skills).set({
              name: skillPackage.name,
              source: 'local',
              root: skillPackage.root,
              directory: skillPackage.directory,
              version: skillPackage.version,
              validation: 'valid',
              validationReason: null,
              instructions: skillPackage.instructions,
              updatedAt: new Date(),
            }).where(and(eq(skills.id, id), eq(skills.workspaceId, workspaceId))).run();
            transaction.delete(skillFiles).where(eq(skillFiles.skillId, id)).run();
            transaction.insert(skillFiles).values(skillPackage.files.map((file) => ({ skillId: id, ...file }))).run();
          });
        }
      } else {
        const reason = item.invalidReason ?? 'The Skill package is invalid.';
        const changed = !existing
          || existing.root !== item.root
          || existing.directory !== item.directory
          || existing.validation !== 'invalid'
          || existing.validationReason !== reason
          || existingPackage.length > 0;
        if (!existing) {
          await this.db.insert(skills).values({
            id,
            workspaceId,
            name: item.directory,
            source: 'local',
            root: item.root,
            directory: item.directory,
            version: 'invalid',
            validation: 'invalid',
            validationReason: reason,
            instructions: '',
            updatedAt: new Date(),
          }).run();
        } else if (changed) {
          await this.db.transaction((transaction) => {
            transaction.update(skills).set({
              name: existing.name,
              source: 'local',
              root: item.root,
              directory: item.directory,
              validation: 'invalid',
              validationReason: reason,
              instructions: '',
              updatedAt: new Date(),
            }).where(and(eq(skills.id, id), eq(skills.workspaceId, workspaceId))).run();
            transaction.delete(skillFiles).where(eq(skillFiles.skillId, id)).run();
          });
        }
      }
    }

    const desiredIds = new Set([...desired.values()].map((item) => localSkillId(workspaceId, item.directory, item.root)));
    const idByName = new Map<string, string>();
    for (const skillPackage of scan.packages) {
      const key = skillNameKey(skillPackage.name);
      if (key && !idByName.has(key)) idByName.set(key, localSkillId(workspaceId, skillPackage.directory, skillPackage.root));
    }

    const mapping = new Map<string, string>();
    const aliasNames = new Map<string, string>();
    const deleteIds = new Set<string>();
    for (const [oldId, migration] of legacyMigrations) {
      const currentId = oldId === 'sk_worklite_platform'
        ? localSkillId(workspaceId, skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME), 'platform')
        : idByName.get(skillNameKey(migration.name)) ?? migration.currentId;
      mapping.set(oldId, currentId);
      aliasNames.set(oldId, migration.name);
      deleteIds.add(oldId);
    }
    for (const row of existingRows) {
      if (row.source !== 'local' || desiredIds.has(row.id)) continue;
      const sameDirectoryId = localSkillId(workspaceId, row.directory, row.root);
      const currentId = row.root === 'platform' && row.directory === skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME)
        ? localSkillId(workspaceId, skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME), 'platform')
        : row.id === previousLocalSkillId(workspaceId, row.directory) && desiredIds.has(sameDirectoryId)
          ? sameDirectoryId
          : idByName.get(skillNameKey(row.name));
      if (!currentId || currentId === row.id) continue;
      mapping.set(row.id, currentId);
      aliasNames.set(row.id, row.name);
      deleteIds.add(row.id);
    }

    const previousAliases = await this.db.select().from(skillIdAliases).where(eq(skillIdAliases.workspaceId, workspaceId));
    const previousAliasById = new Map(previousAliases.map((alias) => [alias.oldSkillId, alias]));
    const aliasUpdates = new Map<string, { currentSkillId: string; skillName: string }>();
    for (const alias of previousAliases) {
      const isPlatformCore = skillNameKey(alias.skillName) === skillNameKey(WORKLITE_PLATFORM_SKILL_NAME);
      const platformCoreId = localSkillId(workspaceId, skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME), 'platform');
      const currentId = (isPlatformCore && desiredIds.has(platformCoreId) ? platformCoreId : undefined)
        ?? idByName.get(skillNameKey(alias.skillName))
        ?? (desiredIds.has(alias.currentSkillId) ? alias.currentSkillId : undefined);
      if (!currentId) continue;
      if (currentId === alias.oldSkillId) continue;
      mapping.set(alias.oldSkillId, currentId);
      aliasNames.set(alias.oldSkillId, alias.skillName);
      if (currentId !== alias.currentSkillId) aliasUpdates.set(alias.oldSkillId, { currentSkillId: currentId, skillName: alias.skillName });
      if (existingById.has(alias.oldSkillId) && !desiredIds.has(alias.oldSkillId)) deleteIds.add(alias.oldSkillId);
    }
    for (const [oldId, currentId] of mapping) {
      const skillName = aliasNames.get(oldId);
      if (!skillName || oldId === currentId || previousAliasById.get(oldId)?.currentSkillId === currentId) continue;
      aliasUpdates.set(oldId, { currentSkillId: currentId, skillName });
    }

    await this.applySkillIdMigrations(workspaceId, mapping, aliasUpdates, deleteIds);

    const obsolete = existingRows.filter((row) => !desiredIds.has(row.id) && !deleteIds.has(row.id));
    if (obsolete.length > 0) {
      const cleanup = await this.removeSkillReferences(workspaceId, new Set(obsolete.map((row) => row.id)), 'disk_removed');
      await this.db.delete(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, obsolete.map((row) => row.id))));
      this.logger.log(`Removed ${obsolete.length} Skill(s) whose disk directories disappeared; cleaned references ${JSON.stringify(cleanup)}.`);
    }

    const conflicts = new Map<string, SkillConflictView>();
    for (const conflict of scan.conflicts) {
      conflicts.set(localSkillId(workspaceId, conflict.winningDirectory, conflict.winningRoot), {
        ignoredRoot: conflict.ignoredRoot,
        ignoredPath: conflict.ignoredPath,
        reason: conflict.reason,
      });
    }
    return { conflicts };
  }

  private async ensurePlatformSkillPackage(workspaceId: string): Promise<void> {
    const coreSkillId = localSkillId(workspaceId, skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME), 'platform');
    const [deleted] = await this.db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'skill.deleted'), eq(auditLogs.resource, coreSkillId))).limit(1);
    if (deleted) return;
    await writeSkillDirectory(platformSkillRootDirectory(), skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME), platformSkillPackageFiles());
  }

  private async migrateLegacySkills(workspaceId: string): Promise<Map<string, { currentId: string; name: string }>> {
    const existingRows = await this.db.select().from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), sql`${skills.source} <> 'local'`))
      .orderBy(asc(skills.name), asc(skills.id));
    const rows = existingRows;
    const coreSeeds = rows.filter((row) => row.id === 'sk_worklite_platform');
    const coreDirectory = skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME);
    const coreSkillId = localSkillId(workspaceId, coreDirectory, 'platform');
    const [coreWasDeleted] = await this.db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'skill.deleted'), eq(auditLogs.resource, coreSkillId))).limit(1);
    const mapping = new Map<string, { currentId: string; name: string }>();
    for (const row of coreSeeds) {
      if (coreWasDeleted) {
        await this.removeSkillReferences(workspaceId, new Set([row.id]), 'user_deleted');
        await this.db.delete(skills).where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, row.id)));
      } else {
        mapping.set(row.id, { currentId: coreSkillId, name: WORKLITE_PLATFORM_SKILL_NAME });
      }
    }
    if (coreSeeds.length === 0 && !coreWasDeleted) {
      mapping.set('sk_worklite_platform', { currentId: coreSkillId, name: WORKLITE_PLATFORM_SKILL_NAME });
    }
    const legacyRows = rows.filter((row) => row.id !== 'sk_worklite_platform');
    if (legacyRows.length === 0) return mapping;
    const files = await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, legacyRows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    const platformRoot = platformSkillRootDirectory();
    await mkdir(platformRoot, { recursive: true });
    const platformScan = await scanLocalSkillRoot(platformRoot, 'platform');
    const agentsScan = await scanLocalSkillRoot(localSkillRootDirectory(), 'agents');
    const packages = new Map(platformScan.packages.map((skillPackage) => [skillPackage.directory, skillPackage]));
    const takenDirectories = new Set([
      ...platformScan.packages.map((skillPackage) => skillPackage.directory),
      ...platformScan.skipped.map((skillPackage) => skillPackage.directory),
      ...agentsScan.packages.map((skillPackage) => skillPackage.directory),
      ...agentsScan.skipped.map((skillPackage) => skillPackage.directory),
    ]);
    for (const row of legacyRows) {
      const packageFiles = storedPackageFiles(files.filter((file) => file.skillId === row.id).map(({ path, content }) => ({ path, content })), row);
      const base = skillDirectoryName(row.name || row.id);
      let directory: string | undefined;
      for (let index = 1; index <= 1000; index += 1) {
        const candidate = suffixDirectory(base, index);
        const existingPackage = packages.get(candidate);
        if (existingPackage && samePackageFiles(existingPackage.files, packageFiles)) {
          directory = candidate;
          break;
        }
        if (takenDirectories.has(candidate)) continue;
        const written = await writeSkillDirectory(platformRoot, candidate, packageFiles);
        takenDirectories.add(candidate);
        if (written === 'created') {
          packages.set(candidate, {
            root: 'platform', rootPath: platformRoot, directory: candidate, name: row.name,
            description: '', metadata: {}, version: row.version, instructions: packageFiles.find((file) => file.path === 'SKILL.md')?.content ?? '',
            files: packageFiles, updatedAt: new Date(),
          });
          directory = candidate;
          break;
        }
      }
      if (!directory) throw new Error(`Could not allocate a platform Skill directory for ${row.name}.`);
      mapping.set(row.id, { currentId: localSkillId(workspaceId, directory, 'platform'), name: row.name });
    }
    if (mapping.size > 0) this.logger.log(`Migrated ${mapping.size} legacy Skill(s) into ${platformRoot}.`);
    return mapping;
  }

  private async applySkillIdMigrations(
    workspaceId: string,
    mapping: ReadonlyMap<string, string>,
    aliases: ReadonlyMap<string, { currentSkillId: string; skillName: string }>,
    deleteIds: ReadonlySet<string>,
  ): Promise<void> {
    await this.db.transaction((transaction) => {
      const oldIds = [...mapping.keys()];
      const assignments = oldIds.length > 0
        ? transaction.select().from(agentSkills).where(inArray(agentSkills.skillId, oldIds)).all()
        : [];
      for (const assignment of assignments) {
        const nextId = mapping.get(assignment.skillId);
        if (!nextId || nextId === assignment.skillId) continue;
        transaction.delete(agentSkills).where(and(eq(agentSkills.agentId, assignment.agentId), eq(agentSkills.skillId, assignment.skillId))).run();
        transaction.insert(agentSkills).values({ agentId: assignment.agentId, skillId: nextId }).onConflictDoNothing().run();
      }

      const [configuration] = transaction.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, workspaceId)).orderBy(desc(chatConfigurations.revision)).limit(1).all();
      const currentSkills = transaction.select({ id: skills.id, name: skills.name, instructions: skills.instructions, root: skills.root, directory: skills.directory }).from(skills).where(eq(skills.workspaceId, workspaceId)).all();
      const platformIds = new Set(currentSkills.filter((skill) => skill.root === 'platform' && skill.directory === skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME)).map((skill) => skill.id));
      if (configuration) {
        const skillIds = mapSkillIds(configuration.skillIds, mapping).filter((id) => id !== 'sk_worklite_platform' && !platformIds.has(id));
        if (!sameStringList(skillIds, configuration.skillIds)) transaction.update(chatConfigurations).set({ skillIds }).where(and(eq(chatConfigurations.workspaceId, workspaceId), eq(chatConfigurations.revision, configuration.revision))).run();
      }

      const drafts = transaction.select().from(workflowDrafts).where(eq(workflowDrafts.workspaceId, workspaceId)).all();
      for (const draft of drafts) {
        const definition = rewriteWorkflowSkillIds(draft.definition, mapping);
        if (definition) transaction.update(workflowDrafts).set({ definition, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id)).run();
      }

      const currentFiles = currentSkills.length === 0 ? [] : transaction.select().from(skillFiles).where(inArray(skillFiles.skillId, currentSkills.map((skill) => skill.id))).orderBy(asc(skillFiles.path)).all();
      const currentSnapshots = new Map<string, StoredAgentTeamSkillSnapshot>();
      for (const skill of currentSkills) currentSnapshots.set(skill.id, {
        id: skill.id,
        name: skill.name,
        instructions: skill.instructions,
        files: currentFiles.filter((file) => file.skillId === skill.id).map(({ path, content }) => ({ path, content })),
      });
      const teams = transaction.select().from(agentTeams).where(eq(agentTeams.workspaceId, workspaceId)).all();
      for (const team of teams) {
        let changed = false;
        const roles = team.roles.map((role) => {
          const next = rewriteRoleSkillIds(role, mapping, false, currentSnapshots);
          if (next) changed = true;
          return next ?? role;
        });
        if (changed) transaction.update(agentTeams).set({ roles, updatedAt: new Date() }).where(eq(agentTeams.id, team.id)).run();
      }

      for (const [oldSkillId, alias] of aliases) {
        transaction.insert(skillIdAliases).values({ workspaceId, oldSkillId, currentSkillId: alias.currentSkillId, skillName: alias.skillName })
          .onConflictDoUpdate({ target: [skillIdAliases.workspaceId, skillIdAliases.oldSkillId], set: { currentSkillId: alias.currentSkillId, skillName: alias.skillName } }).run();
        transaction.insert(auditLogs).values({
          id: `audit_${randomUUID()}`,
          workspaceId,
          action: 'skill.migrated',
          resource: oldSkillId,
          metadata: { oldSkillId, currentSkillId: alias.currentSkillId, skillName: alias.skillName },
        }).run();
      }
      if (deleteIds.size > 0) transaction.delete(skills).where(and(eq(skills.workspaceId, workspaceId), inArray(skills.id, [...deleteIds]))).run();
    });
  }

  private async removeSkillReferences(workspaceId: string, skillIds: ReadonlySet<string>, reason: 'disk_removed' | 'user_deleted'): Promise<SkillReferenceCleanup> {
    const cleanup = emptySkillCleanup();
    if (skillIds.size === 0) return cleanup;
    const ids = [...skillIds];
    const removeMapping = new Map(ids.map((id) => [id, id]));
    await this.db.transaction((transaction) => {
      const assignments = transaction.select().from(agentSkills).where(inArray(agentSkills.skillId, ids)).all();
      if (assignments.length > 0) {
        transaction.delete(agentSkills).where(inArray(agentSkills.skillId, ids)).run();
        cleanup.agentIds = [...new Set(assignments.map((assignment) => assignment.agentId))];
      }

      const [configuration] = transaction.select().from(chatConfigurations).where(eq(chatConfigurations.workspaceId, workspaceId)).orderBy(desc(chatConfigurations.revision)).limit(1).all();
      if (configuration) {
        const nextIds = mapSkillIds(configuration.skillIds, removeMapping, true);
        if (!sameStringList(nextIds, configuration.skillIds)) {
          transaction.update(chatConfigurations).set({ skillIds: nextIds }).where(and(eq(chatConfigurations.workspaceId, workspaceId), eq(chatConfigurations.revision, configuration.revision))).run();
          cleanup.chatConfigurationRevisions.push(configuration.revision);
        }
      }

      const drafts = transaction.select().from(workflowDrafts).where(eq(workflowDrafts.workspaceId, workspaceId)).all();
      for (const draft of drafts) {
        const nodeIds = workflowSkillNodeIds(draft.definition, skillIds);
        if (nodeIds.length === 0) continue;
        const definition = rewriteWorkflowSkillIds(draft.definition, removeMapping, true);
        if (!definition) continue;
        transaction.update(workflowDrafts).set({ definition, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id)).run();
        cleanup.workflowDrafts.push({ workflowId: draft.workflowId, nodeIds });
      }

      const teams = transaction.select().from(agentTeams).where(eq(agentTeams.workspaceId, workspaceId)).all();
      for (const team of teams) {
        let changed = false;
        const roles = team.roles.map((role) => {
          const next = rewriteRoleSkillIds(role, removeMapping, true);
          if (!next) return role;
          changed = true;
          cleanup.agentTeamRoles.push({ teamId: team.id, role: role.role });
          for (const instance of next.developerInstances ?? []) {
            const previous = role.developerInstances?.find((candidate) => candidate.developerId === instance.developerId);
            if (previous && previous.skills.length !== instance.skills.length) cleanup.agentTeamDeveloperInstances.push({ teamId: team.id, role: role.role, developerId: instance.developerId });
          }
          return next;
        });
        if (changed) transaction.update(agentTeams).set({ roles, updatedAt: new Date() }).where(eq(agentTeams.id, team.id)).run();
      }

      for (const skillId of ids) transaction.insert(auditLogs).values({
        id: `audit_${randomUUID()}`,
        workspaceId,
        action: 'skill.references_cleaned',
        resource: skillId,
        metadata: { skillId, reason, cleaned: cleanup },
      }).run();
    });
    return cleanup;
  }

  private async activeChatCapabilityIsReferenced(workspaceId: string, field: 'skills' | 'mcpServers', id: string) {
    const rows = await this.db.select({ snapshot: agentExecutions.capabilitySnapshot }).from(agentExecutions).where(and(eq(agentExecutions.workspaceId, workspaceId), inArray(agentExecutions.status, ['running', 'waiting_for_input'])));
    return rows.some(({ snapshot }) => snapshot?.[field].some((resource) => resource.id === id));
  }

  async skills(request: Request, workspaceSlug: string): Promise<SkillView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const sync = await this.syncLocalSkills(team.id);
    const coreDirectory = skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME);
    const rows = (await this.db.select().from(skills).where(eq(skills.workspaceId, team.id)).orderBy(desc(skills.updatedAt)))
      .filter((row) => row.root !== 'platform' || row.directory !== coreDirectory);
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    const bySkill = new Map<string, PackageFile[]>();
    for (const file of files) bySkill.set(file.skillId, [...(bySkill.get(file.skillId) ?? []), { path: file.path, content: file.content }]);
    return rows.map((row) => skillView(row, workspaceSlug, bySkill.get(row.id) ?? [], sync.conflicts.get(row.id)));
  }

  async skill(request: Request, workspaceSlug: string, skillId: string): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const sync = await this.syncLocalSkills(team.id);
    const [row] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Skill not found');
    const files = await this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, row.id)).orderBy(asc(skillFiles.path));
    return skillView(row, workspaceSlug, files, sync.conflicts.get(row.id));
  }

  async createSkill(request: Request, workspaceSlug: string, input: CreateSkillRequest): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.createPlatformSkill(team.id, workspaceSlug, input, 'created');
  }

  async importSkill(request: Request, workspaceSlug: string, input: ImportSkillRequest): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    return this.createPlatformSkill(team.id, workspaceSlug, input, 'imported');
  }

  private async createPlatformSkill(workspaceId: string, workspaceSlug: string, input: CreateSkillRequest, operation: 'created' | 'imported'): Promise<SkillView> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Skill name is required.');
    const files = validatePackageFiles(input.files);
    const packageName = skillFrontmatter(files).name?.trim() || name;
    if (skillNameKey(packageName) === skillNameKey(WORKLITE_PLATFORM_SKILL_NAME)) {
      throw new ConflictException(`The Skill name "${WORKLITE_PLATFORM_SKILL_NAME}" is reserved for WorkLite.`);
    }
    const base = skillDirectoryName(name);
    await this.syncLocalSkills(workspaceId);
    const roots = await scanLocalSkillRoots();
    const unavailable = roots.roots.find((root) => !root.available && !root.rootMissing);
    if (unavailable) throw new ServiceUnavailableException(unavailable.unavailableReason ?? `Skill root ${unavailable.root} is unavailable.`);
    const agentsRoot = roots.roots.find((root) => root.kind === 'agents');
    const userCopy = agentsRoot?.packages.find((skillPackage) => skillNameKey(skillPackage.name) === skillNameKey(packageName));
    if (userCopy) throw new ConflictException(`A Skill named "${userCopy.name}" already exists in the user Agent root and takes priority.`);
    const takenDirectories = new Set([
      ...roots.packages.map((skillPackage) => skillPackage.directory),
      ...roots.skipped.map((skillPackage) => skillPackage.directory),
      ...roots.conflicts.map((conflict) => conflict.ignoredDirectory),
    ]);
    const platformRoot = platformSkillRootDirectory();
    let directory: string | undefined;
    for (let index = 1; index <= 1000; index += 1) {
      const candidate = suffixDirectory(base, index);
      if (takenDirectories.has(candidate)) continue;
      const written = await writeSkillDirectory(platformRoot, candidate, files);
      takenDirectories.add(candidate);
      if (written === 'created') {
        directory = candidate;
        break;
      }
    }
    if (!directory) throw new ServiceUnavailableException('Could not allocate a Skill directory in the platform root.');
    const sync = await this.syncLocalSkills(workspaceId);
    const id = localSkillId(workspaceId, directory, 'platform');
    const [row] = await this.db.select().from(skills).where(and(eq(skills.id, id), eq(skills.workspaceId, workspaceId))).limit(1);
    if (!row) throw new NotFoundException(`Skill could not be ${operation}`);
    const storedFiles = await this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, id)).orderBy(asc(skillFiles.path));
    return skillView(row, workspaceSlug, storedFiles, sync.conflicts.get(id));
  }

  async deleteSkill(request: Request, workspaceSlug: string, skillId: string): Promise<DeleteSkillResult> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.syncLocalSkills(team.id);
    const [existing] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Skill not found');
    const directoryPath = skillDirectoryPath(existing.root, existing.directory);
    const roots = await scanLocalSkillRoots();
    const fallback = roots.roots.flatMap((root) => root.kind === existing.root ? [] : root.packages)
      .find((skillPackage) => skillNameKey(skillPackage.name) === skillNameKey(existing.name));
    const fallbackId = fallback ? localSkillId(team.id, fallback.directory, fallback.root) : undefined;
    const cleanup = await this.removeSkillReferences(team.id, new Set([skillId]), 'user_deleted');
    await rm(directoryPath, { recursive: true, force: true });
    await this.db.transaction((transaction) => {
      transaction.delete(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).run();
      if (fallback && fallbackId) {
        transaction.insert(skillIdAliases).values({ workspaceId: team.id, oldSkillId: skillId, currentSkillId: fallbackId, skillName: fallback.name })
          .onConflictDoUpdate({ target: [skillIdAliases.workspaceId, skillIdAliases.oldSkillId], set: { currentSkillId: fallbackId, skillName: fallback.name } }).run();
        transaction.insert(auditLogs).values({
          id: `audit_${randomUUID()}`,
          workspaceId: team.id,
          action: 'skill.historical_alias_created',
          resource: skillId,
          metadata: { oldSkillId: skillId, currentSkillId: fallbackId, skillName: fallback.name },
        }).run();
      }
      transaction.insert(auditLogs).values({
        id: `audit_${randomUUID()}`,
        workspaceId: team.id,
        action: 'skill.deleted',
        resource: skillId,
        metadata: { skillId, root: existing.root, directory: existing.directory, directoryPath, cleaned: cleanup },
      }).run();
    });
    this.logger.log(`Deleted Skill ${skillId} from ${existing.root} root at ${directoryPath}; cleaned references ${JSON.stringify(cleanup)}.`);
    return { deleted: skillId, directory: existing.directory, root: existing.root, directoryPath, cleaned: cleanup };
  }

  async executeSkillScript(request: Request, workspaceSlug: string, skillId: string, input: ExecuteSkillScriptRequest): Promise<CommandExecutionView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.syncLocalSkills(team.id);
    const [skill] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!skill) throw new NotFoundException('Skill not found');
    if (skill.validation !== 'valid') throw new BadRequestException(skill.validationReason ?? 'This Skill package is invalid and cannot be executed.');
    if (!input || typeof input.scriptPath !== 'string' || !Array.isArray(input.arguments) || input.arguments.some((argument) => typeof argument !== 'string')) {
      throw new BadRequestException('A Skill script path and string argument array are required.');
    }
    const files = await this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, skillId)).orderBy(asc(skillFiles.path));
    return this.skillScripts.start(files, input.scriptPath, input.arguments);
  }

  async mcpServers(request: Request, workspaceSlug: string): Promise<McpServerView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, team.id)).orderBy(desc(mcpServers.updatedAt));
    return rows.map((row) => mcpServerView(row, workspaceSlug));
  }

  async mcpServer(request: Request, workspaceSlug: string, serverId: string): Promise<McpServerView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('MCP server not found');
    return mcpServerView(row, workspaceSlug);
  }

  async workflowMcpRuntimes(workspaceId: string, serverIds: string[]): Promise<AgentMcpRuntime[]> {
    const uniqueIds = [...new Set(serverIds)];
    if (uniqueIds.length === 0) return [];
    const rows = await this.db.select().from(mcpServers).where(and(eq(mcpServers.workspaceId, workspaceId), inArray(mcpServers.id, uniqueIds)));
    if (rows.length !== uniqueIds.length) throw new NotFoundException('A Workflow Agent MCP server is no longer available.');
    const resolved = await Promise.all(rows.map((server) => server.connection === 'unconfigured' ? this.autoConnectMcpServer(server, true) : server));
    return resolved.flatMap((server) => {
      if (!server.endpoint.trim()) return [];
      let authToken: string | undefined;
      try {
        authToken = server.authSecret ? decryptSecret(server.authSecret) : undefined;
      } catch {
        authToken = undefined;
      }
      return [{ id: server.id, name: server.name, endpoint: server.endpoint, ...(authToken ? { authToken } : {}), allowedTools: server.allowedToolNames ?? [] }];
    });
  }

  async publicModelRuntime(_workspaceId: string, publicModelId: string) {
    const provider = await this.publicAgentModelProvider(publicModelId);
    const separator = publicModelId.indexOf('/');
    const model = publicModelId.slice(separator + 1).trim();
    return this.providerRuntime({} as Request, 'personal', provider.id, model);
  }

  // Resolves a declared model slot (one public model id, or an ordered list of fallback
  // candidates) into the Gateway's ModelCandidate list, in the declared order, for
  // withModelFallback. Every candidate is validated the same way publicModelRuntime validates one.
  async publicModelCandidates(workspaceId: string, publicModelIdOrList: string | readonly string[]): Promise<ModelCandidate[]> {
    const ids = normalizePublicModelList(publicModelIdOrList);
    if (ids.length === 0) throw new BadRequestException('A public provider/model id is required.');
    return Promise.all(ids.map(async (publicModelId) => {
      const runtime = await this.publicModelRuntime(workspaceId, publicModelId);
      return { provider: runtime.provider, model: runtime.model };
    }));
  }

  async assertPublicAgentModel(publicModelId: string): Promise<void> {
    await this.publicAgentModelProvider(publicModelId);
  }

  private async publicAgentModelProvider(publicModelId: string): Promise<Pick<ModelProviderView, 'id' | 'name' | 'protocol'>> {
    const separator = publicModelId.indexOf('/');
    if (separator <= 0 || separator === publicModelId.length - 1) throw new BadRequestException('A public provider/model id is required.');
    const providerName = publicModelId.slice(0, separator).trim();
    const model = publicModelId.slice(separator + 1).trim();
    if (!providerName || !model) throw new BadRequestException('A public provider/model id is required.');
    let gatewayResponse: globalThis.Response;
    try {
      gatewayResponse = await fetch(GATEWAY_PROVIDER_URL);
    } catch {
      throw new ServiceUnavailableException('Portkey Gateway is unavailable.');
    }
    if (!gatewayResponse.ok) throw new ServiceUnavailableException('Portkey Gateway is unavailable.');
    const providers = await gatewayResponse.json() as Array<Pick<ModelProviderView, 'id' | 'name' | 'protocol' | 'models'>>;
    const provider = providers.find((candidate) => candidate.name === providerName);
    if (!provider) throw new NotFoundException(`Model provider ${providerName} was not found.`);
    // A credential-forwarding protocol exchanges typed questions for typed
    // answers, so it cannot serve an Agent's system prompt and output format.
    if (provider.protocol === 'typesafe/systemone') throw new BadRequestException(`Model provider ${providerName} does not support Agent execution.`);
    if (!provider.models.includes(model)) throw new BadRequestException('The selected model is not configured for this provider.');
    return provider;
  }

  async agentMcpRuntimes(request: Request, workspaceSlug: string, agentId: string): Promise<AgentMcpRuntime[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ server: mcpServers }).from(agentMcpServers)
      .innerJoin(agents, eq(agentMcpServers.agentId, agents.id))
      .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
      .where(and(eq(agentMcpServers.agentId, agentId), eq(agents.workspaceId, workspace.id)));
    const resolved = await Promise.all(rows.map(({ server }) => server.connection === 'unconfigured' ? this.autoConnectMcpServer(server, true) : server));
    return resolved.flatMap((server) => {
      if (!server.endpoint.trim()) return [];
      let authToken: string | undefined;
      try {
        authToken = server.authSecret ? decryptSecret(server.authSecret) : undefined;
      } catch {
        authToken = undefined;
      }
      return [{ id: server.id, name: server.name, endpoint: server.endpoint, ...(authToken ? { authToken } : {}), allowedTools: server.allowedToolNames ?? [] }];
    });
  }

  async deleteMcpServer(request: Request, workspaceSlug: string, serverId: string, options: { force?: boolean } = {}): Promise<DeleteMcpServerResult> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('MCP server not found');
    const references = await this.collectMcpServerReferences(team.id, serverId);
    const blocked = references.agents.length > 0 || references.activeChatTurns || references.chatConfiguration;
    const referenced = blocked || references.workflowDrafts.length > 0 || references.workflowVersions.length > 0 || references.agentTeamRoles.length > 0 || references.agentTeamVersions.length > 0;
    if (blocked || (referenced && !options.force)) {
      throw new BadRequestException({ message: mcpServerReferenceMessage(references, options.force === true), references });
    }
    // Force deletion and its in-place reference cleanup share one transaction so a
    // half-cleaned state is impossible. Published WorkflowVersions and captured
    // TeamVersions are immutable history and are never rewritten.
    const cleaned = await this.db.transaction((transaction) => {
      let workflowDraftCount = 0;
      let agentTeamRoleCount = 0;
      if (options.force) {
        const draftRows = transaction.select({ draft: workflowDrafts }).from(workflowDrafts).where(eq(workflowDrafts.workspaceId, team.id)).all();
        for (const { draft } of draftRows) {
          const next = removeMcpServerFromWorkflowDefinition(draft.definition, serverId);
          if (!next) continue;
          const revisionId = `wfr_${randomUUID()}`;
          transaction.insert(workflowEditRevisions).values({ id: revisionId, workspaceId: team.id, workflowId: draft.workflowId, draftId: draft.id, parentRevisionId: draft.currentRevisionId, source: 'migration', sourceInstruction: `Removed the deleted MCP server ${serverId} from Agent node references.`, operations: [], snapshot: next }).run();
          transaction.update(workflowDrafts).set({ currentRevisionId: revisionId, definition: next, updatedAt: new Date() }).where(eq(workflowDrafts.id, draft.id)).run();
          workflowDraftCount += 1;
        }
        const teamRows = transaction.select({ team: agentTeams }).from(agentTeams).where(eq(agentTeams.workspaceId, team.id)).all();
        for (const { team: agentTeam } of teamRows) {
          if (!agentTeam.roles.some((role) => role.mcpServers.some((server) => server.id === serverId))) continue;
          agentTeamRoleCount += agentTeam.roles.filter((role) => role.mcpServers.some((server) => server.id === serverId)).length;
          transaction.update(agentTeams).set({
            roles: agentTeam.roles.map((role) => ({ ...role, mcpServers: role.mcpServers.filter((server) => server.id !== serverId) })),
            updatedAt: new Date(),
          }).where(eq(agentTeams.id, agentTeam.id)).run();
        }
      }
      transaction.delete(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).run();
      return { workflowDrafts: workflowDraftCount, agentTeamRoles: agentTeamRoleCount };
    });
    return { deleted: serverId, force: options.force === true, cleaned };
  }

  // Every reference a deletion decision reports, with concrete locations. Legacy
  // Chat MCP assignments are ignored and removed by the cascading foreign key, so
  // only non-Chat Agent assignments appear here.
  private async collectMcpServerReferences(workspaceId: string, serverId: string): Promise<McpServerReferenceReport> {
    const [agentRows, draftRows, versionRows, teamRows, teamVersionRows, chatConfigurationRows] = await Promise.all([
      this.db.select({ agentId: agentMcpServers.agentId, agentName: agents.name }).from(agentMcpServers)
        .innerJoin(agents, eq(agentMcpServers.agentId, agents.id))
        .where(and(eq(agentMcpServers.mcpServerId, serverId), ne(agentMcpServers.agentId, CHAT_AGENT_ID))),
      this.db.select({ draft: workflowDrafts, workflowName: workflows.name }).from(workflowDrafts)
        .innerJoin(workflows, eq(workflowDrafts.workflowId, workflows.id))
        .where(eq(workflowDrafts.workspaceId, workspaceId)),
      this.db.select({ version: workflowVersions, workflowName: workflows.name }).from(workflowVersions)
        .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
        .where(eq(workflowVersions.workspaceId, workspaceId)),
      this.db.select().from(agentTeams).where(eq(agentTeams.workspaceId, workspaceId)),
      this.db.select().from(agentTeamVersions).where(eq(agentTeamVersions.workspaceId, workspaceId)),
      // Only the latest Chat configuration revision holds a live declaration; older revisions keep their captured ids.
      this.db.select({ projectTaskMcpServerIds: chatConfigurations.projectTaskMcpServerIds }).from(chatConfigurations)
        .where(eq(chatConfigurations.workspaceId, workspaceId)).orderBy(desc(chatConfigurations.revision)).limit(1),
    ]);
    return {
      agents: agentRows.map((row) => ({ agentId: row.agentId, agentName: row.agentName })),
      activeChatTurns: await this.activeChatCapabilityIsReferenced(workspaceId, 'mcpServers', serverId),
      chatConfiguration: chatConfigurationRows[0]?.projectTaskMcpServerIds.includes(serverId) ?? false,
      workflowDrafts: draftRows.flatMap(({ draft, workflowName }) => {
        const nodeIds = workflowNodesReferencingMcpServer(draft.definition, serverId);
        return nodeIds.length ? [{ workflowId: draft.workflowId, workflowName, nodeIds }] : [];
      }),
      workflowVersions: versionRows.flatMap(({ version, workflowName }) => {
        const nodeIds = version.definition ? workflowNodesReferencingMcpServer(version.definition, serverId) : [];
        return nodeIds.length ? [{ workflowId: version.workflowId, workflowName, version: version.version, nodeIds }] : [];
      }),
      agentTeamRoles: teamRows.flatMap((row) => row.roles.flatMap((role) => role.mcpServers.some((server) => server.id === serverId)
        ? [{ teamId: row.id, teamName: row.name, role: role.role, displayName: role.displayName ?? null }]
        : [])),
      agentTeamVersions: teamVersionRows.flatMap((row) => {
        const roles = row.snapshot.roles.filter((role) => role.mcpServers.some((server) => server.id === serverId)).map((role) => role.role);
        return roles.length ? [{ teamId: row.teamId, versionId: row.id, version: row.version, roles }] : [];
      }),
    };
  }

  async createMcpServer(request: Request, workspaceSlug: string, input: CreateMcpServerRequest): Promise<McpServerView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const allowedToolNames = normalizeToolNames(input.allowedTools);
    const [row] = await this.db.insert(mcpServers).values({ id: `mcp_${randomUUID()}`, workspaceId: team.id, name: input.name.trim(), endpoint: input.endpoint.trim(), authSecret: input.authToken ? encryptSecret(input.authToken) : null, connection: 'unconfigured', transport: 'Streamable HTTP', allowedTools: allowedToolNames.length, allowedToolNames, version: 'v1' }).returning();
    if (!row) throw new NotFoundException('MCP server could not be created');
    // A server connects and discovers its tools on creation; only a caller that
    // explicitly supplied a tool selection keeps it instead of every discovered tool.
    const connected = await this.autoConnectMcpServer(row, input.allowedTools === undefined);
    return mcpServerView(connected, workspaceSlug);
  }

  // Connect a server that has never been configured: run the MCP handshake and
  // tools/list, then persist the diagnosable outcome. When the server holds no
  // explicit tool selection and allowAllDiscoveredTools is set, every discovered
  // tool is allowed by default. A failed attempt never throws here; it persists
  // the classified connection state and reason on the resource instead.
  async autoConnectMcpServer(server: typeof mcpServers.$inferSelect, allowAllDiscoveredTools: boolean): Promise<typeof mcpServers.$inferSelect> {
    let authToken: string | undefined;
    try {
      authToken = server.authSecret ? decryptSecret(server.authSecret) : undefined;
    } catch {
      authToken = undefined;
    }
    try {
      const tools = await this.mcpClient.discover({ endpoint: server.endpoint, ...(authToken ? { authToken } : {}) }, AbortSignal.timeout(30_000));
      const allowedToolNames = allowAllDiscoveredTools && (server.allowedToolNames ?? []).length === 0 ? tools.map((tool) => tool.name) : server.allowedToolNames ?? [];
      const [row] = await this.db.update(mcpServers).set({ connection: 'connected', connectionError: null, allowedTools: allowedToolNames.length, allowedToolNames, updatedAt: new Date() }).where(eq(mcpServers.id, server.id)).returning();
      return row ?? server;
    } catch (error) {
      const failure = classifyMcpFailure(error);
      const [row] = await this.db.update(mcpServers).set({ connection: failure.connection, connectionError: failure.error, updatedAt: new Date() }).where(eq(mcpServers.id, server.id)).returning();
      return row ?? server;
    }
  }

  async updateMcpServer(request: Request, workspaceSlug: string, serverId: string, input: UpdateMcpServerRequest): Promise<McpServerView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    if (
      !input
      || typeof input !== 'object'
      || Array.isArray(input)
      || Object.keys(input).some((key) => !['name', 'endpoint', 'authToken', 'allowedTools'].includes(key))
      || (input.name !== undefined && typeof input.name !== 'string')
      || (input.endpoint !== undefined && typeof input.endpoint !== 'string')
      || (input.authToken !== undefined && typeof input.authToken !== 'string')
      || (input.allowedTools !== undefined && !Array.isArray(input.allowedTools))
    ) {
      throw new BadRequestException('Only MCP server name, endpoint, authentication, and allowed tools can be changed.');
    }
    const [existing] = await this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('MCP server not found');
    const name = input.name === undefined ? existing.name : input.name.trim();
    const endpoint = input.endpoint === undefined ? existing.endpoint : input.endpoint.trim();
    const allowedToolNames = input.allowedTools === undefined ? existing.allowedToolNames : normalizeToolNames(input.allowedTools);
    if (!name || !endpoint) throw new BadRequestException('MCP server name and endpoint are required.');
    const [row] = await this.db.update(mcpServers).set({
      name,
      endpoint,
      allowedTools: allowedToolNames.length,
      allowedToolNames,
      ...(input.authToken === undefined ? {} : { authSecret: input.authToken ? encryptSecret(input.authToken) : null }),
      updatedAt: new Date(),
    }).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).returning();
    if (!row) throw new NotFoundException('MCP server not found');
    return mcpServerView(row, workspaceSlug);
  }

  async testMcpServer(request: Request, workspaceSlug: string, serverId: string): Promise<McpServerTestResult> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [server] = await this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).limit(1);
    if (!server) throw new NotFoundException('MCP server not found');
    let authToken: string | undefined;
    try {
      authToken = server.authSecret ? decryptSecret(server.authSecret) : undefined;
    } catch {
      authToken = undefined;
    }
    try {
      const tools = await this.mcpClient.discover({ endpoint: server.endpoint, ...(authToken ? { authToken } : {}) }, AbortSignal.timeout(30_000));
      await this.db.update(mcpServers).set({ connection: 'connected', connectionError: null, updatedAt: new Date() }).where(eq(mcpServers.id, server.id));
      return { connection: 'connected', tools: tools.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })) };
    } catch (error) {
      const failure = classifyMcpFailure(error);
      await this.db.update(mcpServers).set({ connection: failure.connection, connectionError: failure.error, updatedAt: new Date() }).where(eq(mcpServers.id, server.id));
      return { connection: failure.connection, tools: [], error: failure.error };
    }
  }

  async providers(request: Request, workspaceSlug: string): Promise<ModelProviderView[]> {
    await this.workspaces.getWorkspace(request, workspaceSlug);
    try {
      const response = await fetch(GATEWAY_PROVIDER_URL);
      if (!response.ok) return [];
      return await response.json() as ModelProviderView[];
    } catch {
      return [];
    }
  }

  async platformSnapshot(request: Request, workspaceSlug: string) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const skillSync = await this.syncLocalSkills(workspace.id);
    const [providerRows, skillRows, mcpRows, workflowRows, agentTeamRows, scheduleRows, settingsRows, officialAccountRows] = await Promise.all([
      this.providers(request, workspaceSlug),
      this.db.select().from(skills).where(eq(skills.workspaceId, workspace.id)).orderBy(skills.name),
      this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspace.id)).orderBy(mcpServers.name),
      this.db.select().from(workflows).where(eq(workflows.workspaceId, workspace.id)).orderBy(workflows.name),
      this.db.select().from(agentTeams).where(eq(agentTeams.workspaceId, workspace.id)).orderBy(agentTeams.name),
      this.db.select().from(workflowSchedules).where(eq(workflowSchedules.workspaceId, workspace.id)),
      this.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspace.id)).limit(1),
      this.db.select({ id: wechatOfficialAccounts.id, displayName: wechatOfficialAccounts.displayName, status: wechatOfficialAccounts.status }).from(wechatOfficialAccounts).where(eq(wechatOfficialAccounts.workspaceId, workspace.id)),
    ]);
    const coreDirectory = skillDirectoryName(WORKLITE_PLATFORM_SKILL_NAME);
    const visibleSkillRows = skillRows.filter((row) => row.root !== 'platform' || row.directory !== coreDirectory);
    const providerNames = new Map(providerRows.map((provider) => [provider.id, provider.name]));
    const skillNames = new Map(visibleSkillRows.map((skill) => [skill.id, skill.name]));
    const mcpNames = new Map(mcpRows.map((server) => [server.id, server.name]));

    const snapshot = {
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      capabilities: {
        troubleshooting: {
          evidenceOwner: 'Chat',
          repairOwner: 'Chat-owned project task or collaborative Agent Team Run',
          chatHostTools: ['run_host_command'],
          chatDirectTools: ['project_task', 'answer_project_task', 'steer_project_task', 'cancel_project_task', 'update_plan', 'ask_user', 'run_host_command'],
          chatProjectTaskDispatch: 'one project_task per model response; use one common workspace root for a goal spanning projects; rejected batches report invalid_tool_request',
          chatPlatformTools: 'one typed tool per protected worklite-platform script, declared in scripts/tools.json, plus the runtime run_host_command terminal tool',
          chatCustomSkillsAndMcp: 'not selectable; neither the Chat model loop nor its project executors receive custom Skills or MCP servers',
          repairDispatchTool: 'dispatch_task',
          repairDispatchRoute: 'POST /chat/dispatch',
          repairDispatch: 'project_task for independent Chat execution; Chat dispatch_task creates an Agent Team group chat and binds its first role task to a Run',
          inspectionAuthorizesRepair: false,
          gatewayLogs: {
            statistics: { tool: 'inspect_gateway_stats', route: 'GET /portkey-gateway/stats', retention: 'indefinite', filters: ['from', 'to', 'groupBy', ...GATEWAY_ATTRIBUTION_FILTERS] },
            list: { tool: 'inspect_gateway_request_logs', route: 'GET /portkey-gateway/request-logs', filters: ['from', 'to', 'provider', 'model', 'statusClass', ...GATEWAY_ATTRIBUTION_FILTERS, 'limit', 'cursor'] },
            detail: { tool: 'inspect_gateway_request_log', route: 'GET /portkey-gateway/request-logs/:requestLogId', capture: 'complete stored request and response' },
            timeRange: 'explicit absolute from/to ISO-8601 instants',
            requestRetentionHours: 12,
            retentionMetadata: ['from', 'to', 'retainedFrom', 'retentionHours'],
            correlation: ['surface', 'conversationId', 'projectTaskId', 'executor', 'workflowId', 'workflowRunId', 'nodeRunId', 'teamId', 'teamRunId', 'teamRole', 'teamTaskAttemptId', 'teamOperationKey'],
            usageAttribution: {
              surfaces: [...GATEWAY_SURFACES],
              groupBy: [...GATEWAY_STATS_GROUP_BYS],
              defaultGroupBy: 'surface',
              scope: 'conversation, executor, team and workflow groupings count only requests carrying that identifier; surface covers every request',
              persistence: 'attribution is written to the permanent statistics as well as the 12-hour request details',
              coverage: 'only traffic that passes through the Gateway; a Codex task with no declared Gateway model runs on local configuration and contributes no tokens, so executor token usage is never complete',
            },
            profile: 'server-owned WORKLITE_API_URL; no URL or profile override',
          },
        },
        runtimeProfiles: {
          development: { webPort: 3390, proxiedApiPort: 23391, gatewayPort: 23392, separateDatabase: false },
          deployment: { webPort: 23390, apiPort: 23391, gatewayPort: 23392 },
          sharedPersistentState: '.data/deployment',
          persistedStateRetention: {
            maintenance: 'enabled by default without configuration: both SQLite databases run a periodic pass that expires history, reclaims free pages and truncates the WAL (SQLITE_MAINTENANCE_INTERVAL_MINUTES, default 15 minutes; SQLITE_WAL_SIZE_LIMIT_MEGABYTES; SQLITE_INCREMENTAL_VACUUM_PAGES). Each pass is bounded; while a backlog remains passes run about once a minute with four times the per-pass bounds, then return to the normal interval',
            commandStreams: 'COMMAND_STREAM_RETENTION_DAYS, default 3 days, then only COMMAND_STREAM_TAIL_KILOBYTES of trailing output is kept',
            runEventStreams: 'RUN_EVENT_RETENTION_DAYS, default 14 days for the replay stream of a settled Workflow Run, Team Run or Chat execution; the runs, node records, results and artifacts themselves are never pruned. 0 disables the pruner',
            gatewayRequestLogs: '12 hours; statistics are indefinite',
            releases: 'WORKLITE_RELEASE_RETENTION, default 3 newest unreferenced release directories under runtime/releases; pruned on every deployment and upgrade attempt, including the ones that fail',
            upgradeRecords: 'WORKLITE_UPGRADE_RECORD_RETENTION_DAYS, default 30 days for terminal upgrade job records and deployment logs',
          },
        },
        chatAttachments: { upload: 'POST /chat/attachments (raw image body; image/png, image/jpeg, image/gif or image/webp; at most 10 MB; optional fileName, conversationId, projectTaskId query)', read: 'GET /chat/attachments/:id', delete: 'DELETE /chat/attachments/:id', reference: '![description](/api/chat/attachments/att_…)', storage: '.data/deployment/chat-attachments', retention: 'CHAT_ATTACHMENT_RETENTION_HOURS, default 12 hours like Gateway request logs', producers: 'project executors receive attachmentUploadUrl in task input; the Web composer uploads pasted images without a projectTaskId', modelInput: 'a Chat turn inlines live attachments uploaded by the reader (no projectTaskId) as image content blocks, at most 8 images, 3.5 MiB each and 10 MB per request, on the anthropic/messages, openai/chat, openai/responses and codex/responses protocols; an executor report image stays a Markdown reference', feishu: 'replaced by a text note pointing to Web' },
        chatShell: {
          available: true,
          tool: 'run_host_command',
          runtime: '/bin/zsh -lc',
          commandPolicy: 'arbitrary local shell commands; no command allow-list',
          cwd: 'optional absolute existing directory, canonicalized; defaults to WORKLITE_CHAT_HOST_COMMAND_DEFAULT_CWD or the user home',
          stdin: 'closed; interactive prompts fail or time out',
          environment: 'minimal inherited environment for PATH, HOME, user, temporary-directory and locale settings; WorkLite credentials, provider secrets and service settings are excluded',
          concurrency: 'serial within the API process',
          bounds: { defaultTimeoutMs: 'WORKLITE_CHAT_HOST_COMMAND_TIMEOUT_MS, default 120000', maxTimeoutMs: 'WORKLITE_CHAT_HOST_COMMAND_MAX_TIMEOUT_MS, default and hard maximum 900000', outputChars: 'WORKLITE_CHAT_HOST_COMMAND_OUTPUT_CHARS, default 20000', streamChars: 'WORKLITE_CHAT_HOST_COMMAND_STREAM_CHARS, default 40000' },
          evidence: 'agent_tool_calls records the complete argv/command, canonical cwd, status, exit code, duration and bounded stdout/stderr tails; audit metadata excludes environment values',
          safety: 'no tool-level command allow-list; commands run as the API process user with the minimal child environment',
          historicalEvidence: 'legacy Chat Shell records remain readable',
          uncertainRecovery: ['adopt_command', 'mark_failed'],
          automaticReplay: false,
        },
        projectExecutors: { tool: 'project_task', executors: { codex: { pluginId: 'codex-cli-chat', transport: 'App Server stdio JSON-RPC', launch: "configured command word (e.g. cxo, cx, codex) run through the operator's own interactive login shell, exactly like a manual terminal invocation; resolves the operator's own ~/.zshrc aliases, functions and PATH, so a native Codex model uses whichever local Codex configuration that resolution selects; a declared Gateway public model is served through a per-run model_providers.worklite Responses Provider", minimumVersion: '0.157.1', modelProtocols: 'a native Codex model needs no Gateway protocol; a declared Gateway public model requires openai/responses or codex/responses and is served through the Gateway', skills: 'skills/extraRoots/set', mcp: '-c mcp_servers with enabled_tools and env bearer token' }, claude: { pluginId: 'claude-code', transport: 'claude -p stream-json control protocol', configuration: '~/.claude for native defaults, or a per-task --settings override for a declared Gateway model', minimumVersion: '2.1.259', modelProtocols: ['anthropic/messages'], skills: '--plugin-dir', mcp: 'owner-only --mcp-config file plus --disallowedTools' } }, defaultExecutor: 'Chat configuration defaultExecutor (claude unless changed); Team developer role executor', defaultModels: "Chat configuration defaultExecutorModels declares one default model per executor; precedence is the task model parameter, then the declared default, then the executor local default; Claude Code's declaration must be a Gateway public model on an anthropic/messages Provider, while Codex's declaration may be a native model or a Gateway public model on openai/responses or codex/responses", gateway: 'both executors use the WorkLite Gateway for a declared Gateway model; a native Codex model uses its local configuration', nativeTools: true, worklitePlatformToolsForExecutors: false, localConfiguration: 'complete operator configuration', approvals: 'none; executors run without approvals', operationJournal: false, uncertainRecovery: false, interruption: 'task fails without replay; inspect the project state', evidence: 'executor event stream activity, public reply text and process Command', progressText: 'latest complete public executor message; retained after cancellation or failure', chatTaskPrompt: 'task-specific prompt plus immutable user extension; pinned project instructions; previous evidence only on later attempts; active scope changes ask continue unchanged or cancel/create, never steer; replacement waits for persisted cancelled status', capturedLaunch: true, olderSnapshots: 'new task or Run required', readRoute: 'GET /chat/project-tasks/:id', listRoute: 'GET /chat/project-tasks (workspace-wide, across conversations)', subscribeRoute: 'POST /chat/project-tasks/:id/subscribe (one-shot settlement report into the subscribing conversation)', answerRoute: 'POST /chat/project-tasks/:id/answer', cancelRoute: 'POST /chat/project-tasks/:id/cancel', historicalOperationRoute: 'GET /chat/project-tasks/:id?operationKey=:operationKey', inspectTool: 'inspect_project_task', crossConversationTools: ['list_project_tasks', 'subscribe_project_task', 'wait_project_task'], taskOwner: 'Chat conversation', execution: 'background dispatch-and-return; the turn settles at dispatch and settlement or a task question triggers one automatic report turn when the conversation idles', concurrency: 'unlimited parallel tasks per workspace when dispatched separately; each model response may contain at most one project_task call; each new task starts at its workspace root and the executor chooses a Git strategy per project; WorkLite does not create worktrees, merge branches or clean up executor-managed Git state; historical tasks retain their captured worktree behavior', worktree: 'new tasks may use a project-specific worktree when the executor chooses it; no worktree or merge is required; historical WorkLite-managed worktrees keep their captured merge behavior', controlTools: ['answer_project_task', 'cancel_project_task'], taskQuestions: 'read-only on the task card; user answers in Chat through answer_project_task', taskCardSummary: ['goal', 'elapsed duration', 'current progress or terminal status'], taskCardCancellation: 'explicit confirmation with local busy and error feedback', taskScopeChanges: 'ask_user to continue captured task unchanged or cancel-and-create; verify cancelled before replacement dispatch', chatSteering: false, independentOfTeam: true, authorization: 'direct execution; no WorkLite proposal confirmation or command grants', automaticReplay: false, cancellation: 'Chat turn cancellation also cancels the conversation active background tasks' },
        chatCapabilities: {
          cancellation: { route: 'POST /agents/agt_system_helper_chat/executions/:executionId/cancel', states: ['running', 'waiting_for_input'], retained: ['messages', 'draft', 'execution evidence'], uncertainEffects: 'structured recovery; no automatic replay' },
          orchestration: {
            directHostTools: 'run_host_command provides arbitrary local terminal execution with no command allow-list',
            customSkillExecution: false,
            directMcpCalls: false,
            platformTools: 'typed protected worklite-platform tools plus the runtime run_host_command terminal tool',
            executorCapabilities: 'Chat receives selected Skill instructions and files in its turn snapshot; worklite-platform enables run_host_command. Arbitrary Skill scripts and direct user MCP calls stay unavailable. Project executors use native tools, receive no Skills from Chat, and Claude Code tasks receive the MCP servers declared in Chat configuration.',
            codingTarget: 'project_task',
            localCommandTarget: 'run_host_command for everyday installs, system/version/CLI queries, ordinary file management and short local scripts; project_task for writing or changing code, repository-wide investigation, cross-file changes, validation/build/test and deployment',
            collaborationTarget: 'Chat-dispatched Agent Team Run operated from its Chat task card',
            automationTarget: 'published Workflow',
          },
          localProjects: {
            tool: 'search_local_projects',
            scope: 'metadata only: git marker, HEAD, remote origin, root manifest name/description/workspaces and README title/first paragraph',
            excluded: ['source files', '.env and credential files', 'Git objects', 'symlinks outside the scan root'],
            categories: ['company', 'self', 'temp', 'forks', 'other'],
            root: 'WORKLITE_LOCAL_PROJECTS_ROOT or ~/development',
            refresh: 'lazy first bounded scan, TTL background refresh, explicit refresh request',
            aliases: { file: 'local-project-aliases.json next to the index cache; WORKLITE_LOCAL_PROJECTS_ALIASES_PATH overrides', tools: ['list_local_project_aliases', 'set_local_project_alias', 'remove_local_project_alias'], precedence: 'exact alias (2000) above every metadata field (exact metadata 1000); fuzzy aliases above every metadata field', scope: 'existing directories inside the local project root; tools write only the alias dictionary and never touch project code or Git state' },
          },
          newConversation: { intentOwner: 'Chat', presentation: { web: 'contextual button', feishu: 'native card button', wechat: 'exact text command: 新对话' }, action: 'ask_user action new_conversation', submitRoute: 'POST /chat/dispatch', retainsHistory: true, cancelsDomainTasks: false },
          configuration: 'revisioned user extensions',
          turnSnapshot: true,
          updatesApply: 'next user turn',
          configureRoute: 'PATCH /agents/agt_system_helper_chat',
          memory: { store: 'workspace-level chat_memories rows with content, category, source conversation and timestamps', categories: ['rule', 'preference', 'project', 'project_state', 'workflow', 'other'], categoryMetadata: '@worklite/contracts CHAT_MEMORY_CATEGORY_META is the single source for which categories are always injected (rule, preference) versus on-demand', tools: ['list_memories', 'save_memory', 'update_memory', 'delete_memory'], routes: ['GET /chat/memories', 'GET /chat/memories/:id', 'POST /chat/memories', 'PATCH /chat/memories/:id', 'DELETE /chat/memories/:id'], injection: 'bounded projection captured per accepted turn into the capability snapshot system prompt: rule and preference categories inject full content, other categories inject only an id/category/summary catalog for on-demand reads through list_memories', bounds: { contentChars: 2000, entries: 100, promptEntries: 50, promptChars: 6000, catalogEntries: 50, catalogChars: 2000 }, management: 'Web Chat settings dialog, grouped and filterable by category' },
        },
        upgrades: { operatorDeploymentVersion: { command: 'pnpm deploy:local', source: 'apps/web/package.json', bump: 'patch before compilation on every invocation', initialBaseline: 'builds in the project root before starting managed services', laterDeployment: 'installs dependencies and builds in the project root while current services keep running; after success, verifies port ownership, then restarts API, Web and Gateway from project-root build outputs', legacyTakeover: 'reads old current.json release fields and verifies the recorded process paths, groups and target listeners before stopping them', unknownListeners: 'left untouched; deployment fails', failedAttempt: 'consumes source version; build failure leaves current processes untouched; startup failure leaves current.json at the last successful deployment and does not restore the stopped program or data', webVersion: 'version from the last successful deployment', gitMutations: false, databaseBackups: false, automaticRollback: false, releaseSnapshots: false }, proposeRoute: 'POST /upgrades', redeployRoute: 'POST /upgrades/redeploy', redeployTool: 'redeploy', inspectRoute: 'GET /upgrades/:id', authorization: 'explicit current Chat user request; no second confirmation', authorizationBinding: 'persisted user message and immutable release', combinedRepairRedeploy: 'project_task redeployAfterSuccess; managed runner starts after success from the managed project root checkout', deduplication: 'one job per execution and user message', profile: 'current managed runtime only; no model override', progress: 'original conversation; automatic observation after reconnect', requiresManagedBaseline: true, projectRoot: process.env.WORKLITE_PROJECT_ROOT ?? null, phases: ['proposed', 'authorized', 'preflighting', 'draining', 'frozen', 'switching', 'recovering', 'succeeded', 'rolled_back', 'failed'], uninterruptedIngress: false, interruptionPolicy: 'cancel active Agent, Team, Workflow and Command work after isolated preflight; never automatically resume' },
        chat: { workspaceRoute: '/chat', channelsRoute: 'GET /chat/channels', conversationsRoute: 'GET /chat/conversations', conversationRoute: 'GET /chat/conversations/:id', recordsRoute: 'GET /chat/conversations/:id/records', recordsSnapshots: 'latest snapshot plus all non-snapshot events', maxSkillScriptOutputChars: 60000, diagnosticTool: { name: 'inspect_chat_conversation', records: 'current evidence and status/receipt metadata; repeated snapshots and cards referenced', fullToolOutputInput: 'toolCallId', completeEvidence: 'fullRecordsRoute', inferenceHistory: 'raw replay snapshots replaced with explicit retained-evidence references; original history unchanged' }, channels: [{ id: 'web', builtIn: true, presentation: ['streaming', 'markdown', 'questions'] }, { id: 'feishu', builtIn: false, presentation: ['native streamed cards', 'collapsed task details', 'forms', 'QR images', 'files'] }, { id: 'wechat', builtIn: false, presentation: ['text messages', 'QR images', 'Chat attachment images'] }], histories: 'server-persisted; unrelated conversations remain separate', backgroundConversations: { start: 'start_chat_conversation', monitor: ['wait_chat_conversation', 'inspect_chat_conversation'], reply: 'message_chat_conversation', userActivation: false, origin: 'first user message names the starting conversation', messaging: 'only conversations started from the current conversation', nesting: false, recoveryQuestions: 'user only' }, masterAgentId: 'agt_system_helper_chat', dispatchRoute: 'POST /chat/dispatch', taskFeedback: 'task state is independent of Chat turn; Team questions, failures and failed dispatches remain visible', teamDispatch: { owner: 'Chat Agent', recordsRoute: 'GET /agent-teams/:teamId/runs', groupRoute: 'read-only archive at /agent-team-groups/:groupId', runRoute: 'read-only evidence at /agent-team-runs/:runId', requires: ['named teamId', 'goal', 'absolute existing projectDirectory', 'mode'], initialRole: 'Planner unless the user names an active work role', submissionReference: ['groupId', 'runId'], entry: 'dispatch_task creates a hidden persistent group and bound Run; Chat owns the task card and all follow-up actions', controls: ['answer', 'pause', 'resume', 'cancel', 'retry', 'reexecute', 'recover'], roleControl: 'Chat task card controls the bound Run; reexecution creates a new group message and Run', commandAuthorization: 'none; every Team work role executes its commands directly on any channel through its configured tool surface, and WorkLite records command text, exit code, output and Command references as evidence', contextIsolation: ['initially addressed role', 'selected repositories', 'v8-v9 working practice and matching Team memories go only to the initially addressed role', 'v9 project Git policy goes to every project-executor role'], handoffs: 'summary and immutable file references; recipients read document content on demand', busyTeam: 'queue the bound Run when maxConcurrentRuns is reached; start queued Runs FIFO when an active slot opens' }, targets: ['conversation', 'team', 'workflow'], workflowVersions: 'published only', externalPluginId: 'feishu-bot', mergeHistories: false, webAccess: 'inspect and continue selected persisted conversation', feishu: { privateChat: true, defaultTarget: 'conversation', persistentTargetSelection: false, choices: 'current pending Agent question; plan not required', replyProgress: 'separate queued, thinking, responding and processing component in the same CardKit entity', cardPresentation: { transport: 'CardKit JSON 2.0 entity', requiredPermission: 'cardkit:card:write', replyAnimation: 'native fast typewriter', updates: 'component-local; full card for structural transitions', progressIcon: 'neutral native loading icon; no custom animation', taskDetails: 'default-collapsed Team task attempts and Workflow node execution statuses', visibleContext: ['current task or step', 'outcome', 'questions', 'failures', 'QR images', 'answer forms', 'controls'], streamingLifecycle: 'model output only; close for tools, questions and terminal states; renew platform window', persistedDelivery: ['cardId', 'sequence', 'last delivered card', 'streaming start', 'pending idempotent UUID and exact payload'], legacyCardConversion: false }, completedDialogue: 'content without task header or completion label', taskAnswers: 'reply to the task card or submit its form', groupChat: false, inbound: ['text', 'card actions'], outbound: ['updated response cards', 'task questions and controls', 'QR images', 'Team documents', 'Workflow Artifacts'], configurationRoute: '/chat?view=channels', applicationRegistration: { available: true, archetype: 'PersonalAgent', startRoute: 'POST /plugins/feishu-bot/feishu/registration', cancelRoute: 'DELETE /plugins/feishu-bot/feishu/registration', operator: 'user through Web configuration', automaticCredentialPersistence: true, userBinding: 'automatic when returned, otherwise manual', resumable: true, manualExistingApplication: true, platformSetup: ['bot capability', 'IM permissions', 'long-connection message and card subscriptions', 'publication'], userOAuth: false, runtimeCompatibility: 'requires authorized real integration' }, wechat: { pluginId: 'wechat-bot', protocol: 'Tencent iLink bot long-poll', login: { startRoute: 'POST /plugins/wechat-bot/wechat/login', cancelRoute: 'DELETE /plugins/wechat-bot/wechat/login', mechanism: 'QR scan; scanning user becomes the allowed user', credentialStorage: 'encrypted bot token in the plugin row' }, privateChat: true, groupChat: false, inbound: ['text'], outbound: ['whole text replies', 'conversation question prompts', 'task status notifications', 'Workflow QR images', 'Chat attachment images'], streaming: false, cards: false, media: 'images outbound only', defaultTarget: 'conversation', questionAnswers: 'plain text answers to Chat pending questions; Chat Agent handles Team actions', disconnectRoute: 'POST /plugins/wechat-bot/wechat/disconnect', configurationRoute: '/chat?view=channels', staleToken: 'status error; user re-logins by QR' } } },
        supportedResourceOperations: [
          'inspect Gateway statistics and request logs',
          'delegate independent project work to a Codex or Claude Code project executor',
          'install or manage Skills and perform ordinary local terminal work through the general run_host_command tool',
          'inspect Chat project task activity',
          'dispatch collaborative repair to Agent Team',
          'inspect Chat conversations and full saved records',
          'start, monitor and answer a background Chat conversation',
          'inspect and update Chat capabilities',
          'save, update, list and delete workspace long-term memories',
          'propose and inspect managed upgrades',
          'redeploy WorkLite on explicit user request, directly or after a successful authorized project_task',
          'inspect workspace resources',
          'read one Workflow draft graph, published versions, schedule and recent Runs directly with inspect_workflow',
          'read other platform records through the bounded read-only query_platform tool',
          'locate local projects from the read-only metadata index',
          'inspect Workflow capabilities',
          'inspect and configure Agent Teams',
          'inspect Agent Team Run records, archived group transcripts, Runs and documents',
          'manage Team/repository-scoped memories and working practice through Chat',
          'answer, control, recover and retry Agent Team Runs from Chat',
          'dispatch Chat-owned Agent Team Runs and published Workflow tasks',
          'navigate to known WorkLite pages and a Workflow editor by name or id',
          'create non-secret model Provider draft',
          'create Skill package',
          'create remote MCP server (connects and discovers its tools automatically)',
          'delete MCP server with explicit confirmation and reference-protected force',
          'create Workflow draft',
          'edit Workflow draft from a logical plan',
          'replace Workflow draft Agent models',
          'publish Workflow draft',
          'delete Workflow with explicit confirmation and guarded force',
          'change appearance',
          'change language',
        ],
        modelProviderProxy: {
          protocols: ['openai/chat', 'openai/responses', 'anthropic/messages', 'codex/responses', 'typesafe/systemone'],
          requiresExplicitProtocol: true,
          typesafeSystemOne: {
            route: '/api/portkey-gateway/v1/systemone',
            requestShape: 'state and typed questions',
            responseShape: 'typed answers plus preserved JSON state fields',
            modelCatalog: 'manual',
            agentExecution: false,
            workflowNode: true,
            workflowNodeType: 'typesafe/systemone',
            workflowNodeVersion: '1',
            perElementWorkflowNodeType: 'typesafe/systemone-map',
            perElementWorkflowNodeVersion: '1',
            perElementEvaluation: 'one upstream request per element of the array at config.itemsPath, inside a single node invocation',
            perElementRanking: 'deterministic server-side order, minimum, and limit applied after evaluation',
            stateInputPort: 'state',
            statePassthrough: 'object fields retained; non-object state is exposed under state',
            questionsConfig: 'immutable_workflow_version',
            answerRouting: 'structured_output_paths',
            connectionTest: 'typed input and output; failures include the upstream reason and request-log id',
          },
          imageGeneration: {
            route: '/api/portkey-gateway/v1/images/generations',
            codexModel: 'codex/gpt-image-2',
            supportedRequestFields: ['prompt', 'model', 'n', 'background', 'quality', 'size'],
            responseContent: 'data[].b64_json',
            workflowNode: true,
            workflowNodeType: 'worklite/image',
            workflowNodeVersion: '1',
            imageEdits: false,
          },
        },
        agentTeam: {
          available: true,
          predefinedTeamCount: 2,
          teamCreation: false,
          teamDeletion: false,
          teamListRoute: 'GET /agent-teams',
          teamSelection: 'one Chat chooses a named predefined Team by teamId for each dispatch and configuration change; existing company repositories use Company Project Team and greenfield application development uses Application Development Team',
          webRoute: `/agent-teams/${BUILT_IN_AGENT_TEAM_ID}`,
          webDefaultTab: 'records',
          recordsRoute: 'GET /agent-teams/:teamId/runs',
          runRecordsRoute: 'GET /agent-teams/:teamId/runs',
          webGroupCreation: false,
          webConfiguration: false,
          chatAgentDispatchOnly: true,
          dispatchRoute: 'POST /chat/dispatch',
          dispatchRequires: ['named teamId', 'goal in message', 'absolute existing projectDirectory', 'mode'],
          busyDispatch: 'persist as queued when maxConcurrentRuns is reached; start queued Runs FIFO when an active slot opens',
          maxConcurrentRuns: { configurable: true, minimum: 1, default: 3 },
          submissionBinding: 'stable submission id atomically binds groupId and runId; repeated delivery is idempotent',
          orchestrationVersion: { newRuns: 11, defaultInitialRole: 'dispatcher', handoffs: 'role handoffs continue inside the group-bound Run over the captured dynamic role directory', historicalVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
          historicalTeamManager: { role: 'team-manager', appliesTo: 'captured v1-v7 TeamVersions only; new v8-v11 Runs have no Team Manager work role' },
          groupRoutes: {
            persistence: 'groups bind Chat submissions and preserve transcript and repository context for captured Runs',
            archive: 'GET /agent-team-groups/:groupId is read-only history; no user-facing composer, answer, repository mutation or controls',
            operations: 'Chat dispatch and protected Chat platform tools own user-requested actions',
            retiredRoutes: 'Direct group creation, message, answer, group repository and Team group-list APIs are removed; only archive reads/events and Chat-bound reexecution remain',
          },
          teamMemory: { routes: 'GET/POST/PATCH/DELETE /agent-teams/:teamId/memories through protected Chat platform tools', scope: ['Team', 'canonical repository'], injection: 'v11 initially addressed role receives the full captured projection and every other role a bounded index; v8-v10 keep the bounded initial-role projection only; historical v1-v7 retain captured injection behavior', writeOwner: 'Chat has full management; v11 roles may search, read and write Team memories within the Run repository scope through managed tools or the per-task executor MCP endpoint' },
          workingPractice: 'captured by each new v8-v11 group Run and injected into the initially addressed role only',
          projectGitPolicy: { perTeam: true, editableThrough: 'update_agent_team with teamId', capturedBy: 'new v9-v11 TeamVersion', injection: 'every project-executor work role in the captured Run', enforcement: 'guidance for native project executors; WorkLite does not create, merge, or clean Git branches or worktrees' },
          runWebRoute: '/agent-team-runs/:runId',
          predefinedTeamIds: agentTeamRows.map((team) => team.id),
          roles: [...AGENT_TEAM_ROLES],
          dynamicRoleDirectory: { customIds: 'server-assigned stable opaque ids', workRoleCrud: ['POST /agent-teams/:teamId/roles', 'PATCH /agent-teams/:teamId/roles/:roleId', 'DELETE /agent-teams/:teamId/roles/:roleId'], historicalProtectedRole: 'team-manager in captured v1-v7 versions' },
          developerExecution: {
            executors: ['claude', 'codex'],
            roleField: 'developer defaults to claude; orchestration v7-v11 captures executor launches for configured work roles with an executor',
            capturedLaunch: true,
            olderSnapshots: 'new Run required',
            nativeTools: true,
            operationJournal: false,
            processReferences: 'materialized read-only files listed in the task prompt',
            sharedExecutor: 'same project executors as Chat project tasks', commandAuthorization: 'direct execution; no WorkLite proposal confirmation or command grants',
            evidence: 'task.activity executor events and the executor process Command; Team owns final results',
          },
          multiDeveloper: {
            configuration: 'single developer role; the Planner decides per Run how many of the fixed 4 lanes (developer, developer-2, developer-3, developer-4) execute via developmentAssignments without developerId',
            reservedPrimaryId: 'developer',
            orchestrationVersion: 'new TeamVersions use v11, which keeps the v10 Team Dispatcher mode decision and adds role search/read/write Team memory plus a bounded memory index for non-initial roles; v10 starts at the Team Dispatcher unless the user names a role and enforces the decided mode route; v9 has no Team Manager role, captured project Git policy for project-executor roles, and working practice plus matching memories in the initially addressed role; v8 has no Team Manager and retains initial-role working practice and memory projections; v7 keeps its protected Team Manager; v6 retains dynamic group handoffs and Developer fan-out; v4 keeps managed worktree lifecycle and v5 keeps advisory per-project strategy; versions 1–10 keep their captured graphs, prompts, tool surfaces and dispatch-time mode',
            taskKeys: 'group_<step>_<role> and group_<step>_developer_<developerId> in v6; earlier versions keep their captured keys',
            assignments: 'planner-produced non-overlapping ownedPaths mapped to lanes in order; targeted repairRequests per developerId; a role output that fails validation earns exactly one corrective re-invocation',
            retryBarrier: 'one retry resumes all failed assignments in the same fan-out; completed siblings never rerun',
            progress: 'run.progress events and run progress view: phase, next step, percent, assignment completion, active developerIds; task events carry developerId and assignmentTitle; attempts carry progressText',
            pendingInputs: 'Chat task cards list every waiting question; each answer uses its own pendingInputId and scopeRevision',
          },
          worktreeManager: 'v4 creates and manages Run/lane worktrees; v5-v11 use advisory per-project strategy; v6-v11 role handoffs do not create, merge or clean Git state',
          modes: ['plan_only', 'validate_existing', 'implement_and_validate'],
          modeSelection: 'Agent Teams do not accept a mode on dispatch. The v10-v11 Dispatcher decides it and records modeRationale and modeDecidedAt on the Run; historical v1-v9 Runs keep their captured mode.',
          teamRoutes: {
            detail: 'GET /agent-teams/:teamId',
            update: 'PATCH /agent-teams/:teamId',
            createRole: 'POST /agent-teams/:teamId/roles (server assigns stable role id)',
            updateRole: 'PATCH /agent-teams/:teamId/roles/:roleId',
            deleteRole: 'DELETE /agent-teams/:teamId/roles/:roleId',
            records: 'GET /agent-teams/:teamId/runs (read-only Run summaries)',
            archive: 'GET /agent-team-groups/:groupId (read-only transcript)',
            groups: 'internal Chat dispatch persistence; no user-facing create or message route',
            memories: 'GET/POST/PATCH/DELETE /agent-teams/:teamId/memories',
          },
          documentRoutes: {
            detail: 'GET /agent-team-documents/:documentId',
            download: 'GET /agent-team-documents/:documentId/download',
          },
          runRoutes: {
            detail: 'GET /agent-team-runs/:runId',
            events: 'GET /agent-team-runs/:runId/events',
            answer: 'POST /agent-team-runs/:runId/answer',
            recoverOperation: 'POST /agent-team-runs/:runId/operations/:operationKey/recovery',
            pause: 'POST /agent-team-runs/:runId/pause',
            resume: 'POST /agent-team-runs/:runId/resume',
            cancel: 'POST /agent-team-runs/:runId/cancel',
            retryTask: 'POST /agent-team-runs/:runId/tasks/:taskKey/retry',
          },
          events: { persisted: true, replay: 'Last-Event-ID', live: 'server-sent events', taskActivity: 'developer executor process, session or thread, and command, file and tool activity' },
          directRunCreationApi: false,
          commandAuthorization: 'none; every work role executes commands directly. Non-executor roles run them through the WorkLite bash tool when their configured tool surface includes it, which Test Runner and Reviewer do by default, with recorded Command evidence, and project-executor roles keep native direct execution. Historical Runs retain their recorded authorizedCommands as read-only evidence',
          recoveryDecisions: ['adopt_command', 'mark_failed', 'replay'],
          uncertainOperationRecovery: {
            cancellationPreservesRecoveryInput: true,
            adoptionOrReplaySupersedesPendingCancellation: true,
            markFailedSettlesWithoutReplay: true,
          },
          capturedVersions: 'developer backend and executable arguments; role model, instruction, Skill, MCP, and process configuration',
        },
        workflow: {
          primaryService: true,
          agentNodesAreSelfContained: true,
          creation: 'blank draft opened directly in the editor',
          supportedNodeTypes: listWorkflowNodeCapabilities().map((capability) => ({
            type: capability.id,
            version: capability.version,
            name: capability.name,
            purpose: capability.purpose,
            inputs: capability.inputs,
            outputs: capability.outputs,
            inputSchema: capability.inputSchema,
            outputSchema: capability.outputSchema,
            configSchema: capability.configSchema,
          })),
          unsupportedFeatures: ['standalone Agent resources', 'Agent version references', 'template selection', 'dynamic joins', 'parallel execution', 'webhook triggers', 'API triggers', 'notification nodes'],
          controlFlow: { edgeModes: ['always', 'predicate', 'fallback'], predicatePaths: 'dot_delimited_output_path', boundedLoops: true, traversalLimitField: 'maxTraversals', cycleRule: 'every_cycle_crosses_a_bounded_edge', initialSourceRule: 'no_unbounded_incoming_edges_and_no_connected_required_inputs', agentContext: { maximumInitialEdges: 1, initialEdgeUnbounded: true, maximumBoundedFeedbackEdges: 1, workflowInputEdgeMustBeUnconditionalAndUnbounded: true }, explicitInitialInputEdges: { available: true, source: 'worklite/input.output', target: 'worklite/agent.context', mustBeUnconditionalAndUnbounded: true, mayCombineWithOneBoundedFeedbackEdge: true }, choiceBranch: { nodeType: 'worklite/branch', version: '1', inputPort: 'value', outputPort: 'output', selection: 'first_matching_outgoing_edge_in_definition_order', fallback: 'first_fallback_edge_when_no_non_fallback_edge_matches', passThrough: 'original_json_value' }, execution: 'deterministic_sequential_token_scheduler' },
          approvedArticle: { nodeType: 'worklite/approved-article', version: '1', requiresApproval: true, rejectsDuplicate: true, preservesWriterMarkdown: true },
          workflowAgentReview: { passthroughKeys: true, maxToolCalls: true, maxToolRounds: true, maxToolResultChars: true },
          artifactHistoryQuery: { nodeType: 'worklite/artifact-query', version: '1', scope: 'workspace_json_artifact_history_including_detached', requestPassthrough: true, emptyCandidatesAllowed: true, readOnly: true },
          graphMutationAvailable: true,
          graphMutationNote: 'Use edit-workflow.mjs with a logical Workflow Plan. Edges may declare structured conditions and positive maxTraversals bounds. The server generates node IDs and positions, validates capabilities, ports, resources, conditions, and bounded-cycle constraints, then records an assistant revision.',
          draftAgentModelReplacement: { available: true, tool: 'replace_workflow_agent_models', route: 'POST /workflows/:workflowId/draft/model-replacement', scope: 'mutable draft only; published WorkflowVersions and Runs unchanged', targetValidation: 'public model exists in the Gateway Provider catalog on an Agent-compatible protocol' },
          deletion: { available: true, tool: 'delete_workflow', route: 'DELETE /workflows/:workflowId', confirmation: 'Chat requires confirm:true after an explicit user deletion request; Web uses the Editor permanent-delete dialog', force: 'optional force=true query; defaults false and bypasses only active-schedule and Home board-assignment guards', guards: { activeRuns: ['queued', 'running', 'paused', 'waiting_for_input'], activeRunPolicy: 'always reject, including force=true', activeSchedule: 'enabled or running projection; reject unless force=true', homeBoardAssignment: 'reject unless force=true' }, transaction: 'guards and all deletions in one workspace-scoped transaction', retainedArtifacts: 'preserved with detached Workflow and Run references' },
          scheduling: { available: true, owner: 'timer_node', nodeType: 'worklite/timer', minimumIntervalSeconds: 300, maximumPerWorkflow: 1, activatesOnPublish: true, preventsOverlap: true },
          runLifecycle: { pause: { available: true, endpoint: 'POST /runs/:runId/pause', eligibleStatuses: ['queued', 'running'] }, resume: { available: true, endpoint: 'POST /runs/:runId/resume', eligibleStatuses: ['paused', 'cancelled'], eligibilitySource: 'run_resumable', cancelledRequiresSchedulerState: true }, checkpoint: 'none_for_active_invocation', resumeBehavior: 'rerun_active_invocation_from_start', completedPredecessorsRerun: false, waitingForInputPause: false },
          runHistory: { location: 'workflow_list_dialog', nodeExecutionLogs: true, failureReasons: true, artifactEligibilitySource: 'immutable_workflow_version' },
          failedNodeRetry: { available: true, scope: 'active_failed_node_run', endpoint: 'POST /runs/:runId/nodes/:nodeRunId/retry', eligibilitySource: 'node_run_retryable', rerunsPredecessors: false, earlierSuccessfulNodes: false },
          humanGatedExecution: { durable: true, runStatus: 'waiting_for_input', resumesSameNode: true, qrPayloadOnly: true, supportedActions: ['wechat_login', 'wechat_publish_confirmation'] },
          wechatOfficialAccounts: officialAccountRows,
          chatInvocation: { available: true, syntax: '@Workflow', publishedOnly: true, inputSource: 'remaining_message_text', execution: 'latest_published_version_run', presentsArtifacts: true },
        },
        homeDashboard: { globalWorkflowDataSource: false, boardEligibility: 'dashboard_node_and_successful_run', workflowOutputPersistence: false, boardCategories: { defaultGroup: 'uncategorized', databaseBacked: true, maximumPerBoard: 1 } },
        requiresExplicitConfirmation: true,
        mcpToolNamesAvailable: false,
        mcpToolDataNote: 'Only the allowed-tool count is persisted. Do not invent or infer MCP tool names.',
      },
      modelProviders: providerRows.map((provider) => ({
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        status: provider.status,
        models: provider.models ?? [],
      })),
      skills: visibleSkillRows.map((skill) => ({
        id: skill.id,
        name: skill.name,
        source: skill.source,
        root: skill.root,
        rootPath: skillRootDirectory(skill.root),
        directory: skill.directory,
        version: skill.version,
        validation: skill.validation,
        ...(skill.validationReason ? { validationReason: skill.validationReason } : {}),
        ...(skillSync.conflicts.get(skill.id) ? { conflict: skillSync.conflicts.get(skill.id) } : {}),
      })),
      mcpServers: mcpRows.map((server) => ({
        id: server.id,
        name: server.name,
        connection: server.connection,
        connectionError: server.connectionError ?? null,
        transport: server.transport,
        allowedToolCount: server.allowedTools,
        version: server.version,
      })),
      agentTeams: agentTeamRows.map((team) => ({
        id: team.id,
        name: team.name,
        description: team.description,
        processId: team.processId,
        processVersion: team.processVersion,
        maxConcurrentRuns: team.maxConcurrentRuns,
        projectGitPolicy: team.projectGitPolicy,
      })),
      workflows: workflowRows.map((workflow) => {
        const schedule = scheduleRows.find((candidate) => candidate.workflowId === workflow.id);
        return {
          id: workflow.id,
          name: workflow.name,
          state: workflow.state,
          schedule: schedule ? { enabled: schedule.enabled, intervalSeconds: schedule.intervalSeconds, workflowVersionId: schedule.workflowVersionId, nextRunAt: schedule.nextRunAt.toISOString(), lastStatus: schedule.lastStatus } : null,
        };
      }),
      settings: settingsRows[0] ? { appearance: settingsRows[0].appearance } : null,
    };
    snapshot.capabilities.projectExecutors.executors.codex.launch = 'When no model is selected, launch the codex command directly and use the operator Codex default, optionally selecting a config directory with --config-dir. When a Chat default or task model is selected, keep the configured command word and inject a per-run model_providers.worklite Responses Provider.';
    snapshot.capabilities.projectExecutors.executors.codex.modelProtocols = 'Without a selected model, Codex uses its local default; a selected Gateway model requires openai/responses or codex/responses and is served through the Gateway.';
    snapshot.capabilities.projectExecutors.defaultModels = "Precedence is task model, Chat configuration default, then executor local default. A selected Codex model is a Gateway public model on openai/responses or codex/responses; without a selected model Codex uses its local default.";
    snapshot.capabilities.projectExecutors.gateway = 'Claude Code and selected Codex models use the WorkLite Gateway; an unmodeled Codex task uses its local configuration.';
    snapshot.capabilities.troubleshooting.chatCustomSkillsAndMcp = 'Chat can select Skills from the shared workspace pool; selected instructions are captured into each Chat turn. Only protected tools provisioned for the selected Skills are callable; custom Skill scripts and user-assigned MCP servers remain unavailable to Chat or its project executors.';
    return snapshot;
  }

  async settings(request: Request, workspaceSlug: string): Promise<WorkspaceSettingsView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspace.id)).limit(1);
    if (!row) throw new NotFoundException('Workspace settings not found');
    return { appearance: row.appearance, updatedAt: row.updatedAt.toISOString() };
  }

  async updateSettings(request: Request, workspaceSlug: string, input: UpdateWorkspaceSettingsRequest): Promise<WorkspaceSettingsView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Workspace settings must be an object.');
    if (Object.keys(input).some((key) => key !== 'appearance')) throw new BadRequestException('Only appearance can be changed.');
    if (input.appearance !== undefined && input.appearance !== 'system' && input.appearance !== 'light' && input.appearance !== 'dark') throw new BadRequestException('Unsupported appearance preference.');
    if (input.appearance === undefined) throw new BadRequestException('At least one workspace setting is required.');
    const [row] = await this.db.update(workspaceSettings).set({
      ...(input.appearance === undefined ? {} : { appearance: input.appearance }),
      updatedAt: new Date(),
    }).where(eq(workspaceSettings.workspaceId, workspace.id)).returning();
    if (!row) throw new NotFoundException('Workspace settings not found');
    return { appearance: row.appearance, updatedAt: row.updatedAt.toISOString() };
  }

  async resolveNavigation(request: Request, workspaceSlug: string, input: { target?: unknown }) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'target')) throw new BadRequestException('A navigation target is required.');
    if (!isWorkliteNavigationTarget(input.target)) throw new BadRequestException('Unsupported WorkLite navigation target.');
    const target = input.target;
    if (target.startsWith('/workflows/')) {
      const workflowId = target.slice('/workflows/'.length);
      const [workflow] = await this.db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, workspace.id))).limit(1);
      if (!workflow) throw new NotFoundException('Workflow not found');
    }
    const route = resolveWorkliteNavigationRoute(target);
    if (!route) throw new BadRequestException('Unsupported WorkLite navigation target.');
    return { type: 'navigation' as const, target, route };
  }

  async upsertProvider(request: Request, workspaceSlug: string, input: CreateModelProviderRequest): Promise<ModelProviderView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Provider name is required.');
    const protocol = input.protocol;
    if (!isStoredProtocol(protocol)) throw new BadRequestException('Unsupported model provider protocol.');
    const headers = normalizeHeaders(input.headers);
    const serializedHeaders = headers === undefined ? undefined : encryptSecret(JSON.stringify(headers));
    const baseURL = input.baseURL?.trim() || null;
    if (!baseURL) throw new BadRequestException('Base URL is required.');
    const models = input.models?.map((model) => model.trim()).filter(Boolean);
    const [existing] = await this.db.select().from(modelProviders).where(and(eq(modelProviders.workspaceId, team.id), eq(modelProviders.name, name))).limit(1);
    if (existing?.id === GATEWAY_PROVIDER_ID) throw new BadRequestException('The protected Gateway Provider cannot be changed.');
    const apiKey = input.apiKey?.trim();
    const [row] = existing
      ? await this.db.update(modelProviders).set({ protocol, baseURL, ...(apiKey ? { apiKey: encryptSecret(apiKey), maskedKey: maskSecret(apiKey), status: 'connected' as const } : {}), ...(models ? { models } : {}), ...(serializedHeaders !== undefined ? { headers: serializedHeaders } : {}), updatedAt: new Date() }).where(eq(modelProviders.id, existing.id)).returning()
      : await this.db.insert(modelProviders).values({ id: `prov_${randomUUID()}`, workspaceId: team.id, name, protocol, baseURL, apiKey: apiKey ? encryptSecret(apiKey) : null, maskedKey: apiKey ? maskSecret(apiKey) : '', status: apiKey ? 'connected' : 'unconfigured', models: models ?? [], headers: serializedHeaders ?? null }).returning();
    if (!row) throw new NotFoundException('Model provider could not be saved');
    if (models) {
      const boundAgents = await this.db.select({ id: agents.id, model: agents.model }).from(agents).where(eq(agents.providerId, row.id));
      const fallbackModel = models[0] ?? '';
      for (const agent of boundAgents) {
        if (agent.model && models.includes(agent.model)) continue;
        await this.db.update(agents).set({ model: fallbackModel, updatedAt: new Date() }).where(eq(agents.id, agent.id));
      }
    }
    return providerView(row);
  }

  async updateProvider(request: Request, workspaceSlug: string, providerId: string, input: UpdateModelProviderRequest): Promise<ModelProviderView> {
    if (providerId === GATEWAY_PROVIDER_ID) throw new BadRequestException('The protected Gateway Provider cannot be changed.');
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(modelProviders).where(and(eq(modelProviders.id, providerId), eq(modelProviders.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Model provider not found');
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new BadRequestException('Provider name is required.');
    const protocol = input.protocol ?? existing.protocol;
    if (!isStoredProtocol(protocol)) throw new BadRequestException('Unsupported model provider protocol.');
    const baseURL = input.baseURL === undefined ? existing.baseURL : input.baseURL.trim() || null;
    if (!baseURL) throw new BadRequestException('Base URL is required.');
    const headers = normalizeHeaders(input.headers);
    const serializedHeaders = headers === undefined ? undefined : encryptSecret(JSON.stringify(headers));
    const models = input.models === undefined ? undefined : input.models.map((model) => model.trim()).filter(Boolean);
    const apiKey = input.apiKey?.trim();
    const [row] = await this.db.update(modelProviders).set({
      name,
      protocol,
      baseURL,
      ...(apiKey ? { apiKey: encryptSecret(apiKey), maskedKey: maskSecret(apiKey), status: 'connected' as const } : {}),
      ...(models === undefined ? {} : { models }),
      ...(serializedHeaders === undefined ? {} : { headers: serializedHeaders }),
      updatedAt: new Date(),
    }).where(and(eq(modelProviders.id, providerId), eq(modelProviders.workspaceId, team.id))).returning();
    if (!row) throw new NotFoundException('Model provider could not be saved');
    if (models !== undefined) {
      const boundAgents = await this.db.select({ id: agents.id, model: agents.model }).from(agents).where(eq(agents.providerId, row.id));
      const fallbackModel = models[0] ?? '';
      for (const agent of boundAgents) {
        if (agent.model && models.includes(agent.model)) continue;
        await this.db.update(agents).set({ model: fallbackModel, updatedAt: new Date() }).where(eq(agents.id, agent.id));
      }
    }
    return providerView(row);
  }

  async providerRuntime(
    request: Request,
    workspaceSlug: string,
    providerId: string,
    selectedModel?: string,
  ): Promise<{ provider: ModelProviderConfig; model: string; protocol: ModelProviderView['protocol'] }> {
    await this.workspaces.getWorkspace(request, workspaceSlug);
    let gatewayResponse: globalThis.Response;
    try {
      gatewayResponse = await fetch(`${GATEWAY_PROVIDER_URL}/${encodeURIComponent(providerId)}`);
    } catch {
      throw new ServiceUnavailableException('Portkey Gateway is unavailable.');
    }
    if (!gatewayResponse.ok) throw new NotFoundException('Model provider not found');
    const gatewayProvider = await gatewayResponse.json() as { name: string; protocol: ModelProviderView['protocol']; models: string[] };
    const configuredModels = (gatewayProvider.models ?? []).map((value) => value.trim()).filter(Boolean);
    const model = (selectedModel?.trim() || configuredModels[0]);
    if (!model) throw new BadRequestException('Add at least one model id before using this provider.');
    if (selectedModel && !configuredModels.includes(model)) throw new BadRequestException('The selected model is not configured for this provider.');
    const provider = gatewayProvider.protocol === 'anthropic/messages'
      ? { id: GATEWAY_PROVIDER_ID, adapter: 'anthropic' as const, apiKey: 'worklite-gateway', gatewayProviderName: gatewayProvider.name, operation: 'messages' as const }
      : gatewayProvider.protocol === 'codex/responses'
      ? { id: GATEWAY_PROVIDER_ID, adapter: 'codex' as const, apiKey: 'worklite-gateway', gatewayProviderName: gatewayProvider.name, operation: 'responses' as const }
      : gatewayProvider.protocol === 'openai/responses'
      ? { id: GATEWAY_PROVIDER_ID, adapter: 'openai' as const, apiKey: 'worklite-gateway', gatewayProviderName: gatewayProvider.name, operation: 'responses' as const }
      : gatewayProvider.protocol === 'openai/chat'
      ? { id: GATEWAY_PROVIDER_ID, adapter: 'openai' as const, apiKey: 'worklite-gateway', gatewayProviderName: gatewayProvider.name, operation: 'chat/completions' as const }
      : (() => { throw new BadRequestException('Unsupported model provider protocol.'); })();
    return { provider, model, protocol: gatewayProvider.protocol };
  }

  async deleteProvider(request: Request, workspaceSlug: string, providerId: string): Promise<void> {
    if (providerId === GATEWAY_PROVIDER_ID) throw new BadRequestException('The protected Gateway Provider cannot be deleted.');
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.db.update(agents).set({ providerId: null, model: '', updatedAt: new Date() }).where(and(eq(agents.workspaceId, team.id), eq(agents.providerId, providerId)));
    const [row] = await this.db.delete(modelProviders)
      .where(and(eq(modelProviders.id, providerId), eq(modelProviders.workspaceId, team.id)))
      .returning({ id: modelProviders.id });
    if (!row) throw new NotFoundException('Model provider not found');
  }

  async artifactsList(request: Request, workspaceSlug: string, query: ArtifactListQuery = {}): Promise<ArtifactListPageView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    return listArtifacts(this.db, team.id, workspaceSlug, query);
  }

  async artifact(request: Request, workspaceSlug: string, artifactId: string): Promise<ArtifactDetailView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const artifact = await getArtifactDetail(this.db, team.id, workspaceSlug, artifactId);
    if (!artifact) throw new NotFoundException('Artifact not found');
    return artifact;
  }

  async artifactContent(request: Request, workspaceSlug: string, artifactId: string): Promise<{ content: Buffer; mimeType: string; sizeBytes: number; fileName: string }> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [artifact] = await this.db.select({ id: artifacts.id, type: artifacts.type, objectKey: artifacts.objectKey, mimeType: artifacts.mimeType, sizeBytes: artifacts.sizeBytes, name: artifacts.name })
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, team.id)))
      .limit(1);
    if (!artifact || artifact.type !== 'image' || !artifact.objectKey) throw new NotFoundException('Artifact image not found');
    const content = await this.artifactStorage.read(artifact.objectKey);
    return {
      content,
      mimeType: artifact.mimeType ?? 'image/png',
      sizeBytes: artifact.sizeBytes ?? content.byteLength,
      fileName: `${artifact.id}.png`,
    };
  }

  async deleteArtifact(request: Request, workspaceSlug: string, artifactId: string): Promise<void> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [deleted] = await this.db.delete(artifacts).where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, team.id))).returning({ id: artifacts.id, type: artifacts.type, objectKey: artifacts.objectKey });
    if (!deleted) throw new NotFoundException('Artifact not found');
    if (deleted.type === 'image' && deleted.objectKey) await this.artifactStorage.remove(deleted.objectKey);
  }

  private async workflowResourceIsReferenced(workspaceId: string, field: 'skillIds' | 'mcpServerIds', resourceId: string): Promise<boolean> {
    const [draftRows, versionRows] = await Promise.all([
      this.db.select({ definition: workflowDrafts.definition }).from(workflowDrafts).where(eq(workflowDrafts.workspaceId, workspaceId)),
      this.db.select({ definition: workflowVersions.definition }).from(workflowVersions).where(eq(workflowVersions.workspaceId, workspaceId)),
    ]);
    return [...draftRows, ...versionRows].some(({ definition }) => definition?.nodes.some((node) => {
      if (node.type !== 'worklite/agent') return false;
      if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config)) return false;
      const ids = (node.config as Record<string, unknown>)[field];
      return Array.isArray(ids) && ids.includes(resourceId);
    }));
  }

  private async agentTeamResourceIsReferenced(
    workspaceId: string,
    field: 'skills' | 'mcpServers',
    resourceId: string,
  ): Promise<boolean> {
    const [teamRows, versionRows] = await Promise.all([
      this.db.select({ roles: agentTeams.roles }).from(agentTeams).where(eq(agentTeams.workspaceId, workspaceId)),
      this.db.select({ snapshot: agentTeamVersions.snapshot }).from(agentTeamVersions).where(eq(agentTeamVersions.workspaceId, workspaceId)),
    ]);
    return [...teamRows, ...versionRows.map((row) => ({ roles: row.snapshot.roles }))]
      .some(({ roles }) => roles.some((role) => role[field].some((resource) => resource.id === resourceId)));
  }

  async usage(request: Request, workspaceSlug: string): Promise<UsageRow[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select({ runs: sql<number>`count(*)` }).from(workflowRuns).where(eq(workflowRuns.workspaceId, team.id));
    const runs = Number(row?.runs ?? 0);
    return runs ? [{ model: 'workflow', tokens: 0, runs, cost: 0 }] : [];
  }

  async audit(request: Request, workspaceSlug: string): Promise<AuditEventView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ audit: auditLogs }).from(auditLogs).where(eq(auditLogs.workspaceId, team.id)).orderBy(desc(auditLogs.createdAt));
    return rows.map(({ audit }) => ({ id: audit.id, actor: 'You', action: audit.action, resource: audit.resource, timestamp: audit.createdAt.toISOString(), metadata: JSON.stringify(audit.metadata) }));
  }

}

function workflowNodesReferencingMcpServer(definition: StoredWorkflowDefinition, serverId: string): string[] {
  return definition.nodes.flatMap((node) => {
    if (node.type !== 'worklite/agent' || !node.config || typeof node.config !== 'object' || Array.isArray(node.config)) return [];
    const ids = (node.config as Record<string, unknown>).mcpServerIds;
    return Array.isArray(ids) && ids.includes(serverId) ? [node.id] : [];
  });
}

// Returns the cleaned definition, or null when no Agent node referenced the server.
function removeMcpServerFromWorkflowDefinition(definition: StoredWorkflowDefinition, serverId: string): StoredWorkflowDefinition | null {
  if (workflowNodesReferencingMcpServer(definition, serverId).length === 0) return null;
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type !== 'worklite/agent' || !node.config || typeof node.config !== 'object' || Array.isArray(node.config)) return node;
      const config = node.config as Record<string, unknown>;
      const ids = config.mcpServerIds;
      if (!Array.isArray(ids) || !ids.includes(serverId)) return node;
      return { ...node, config: { ...config, mcpServerIds: ids.filter((id) => id !== serverId) } };
    }),
  };
}

function mcpServerReferenceMessage(references: McpServerReferenceReport, force: boolean): string {
  const locations: string[] = [];
  if (references.workflowDrafts.length) locations.push(`Workflow draft ${references.workflowDrafts.map((draft) => `"${draft.workflowName}" (nodes: ${draft.nodeIds.join(', ')})`).join(', ')}`);
  if (references.workflowVersions.length) locations.push(`published Workflow ${references.workflowVersions.map((version) => `"${version.workflowName}" v${version.version} (nodes: ${version.nodeIds.join(', ')})`).join(', ')}`);
  if (references.agentTeamRoles.length) locations.push(`Agent Team ${references.agentTeamRoles.map((ref) => `"${ref.teamName}" role ${ref.displayName ?? ref.role}`).join(', ')}`);
  if (references.agentTeamVersions.length) locations.push(`captured Team version ${references.agentTeamVersions.map((version) => `v${version.version} (roles: ${version.roles.join(', ')})`).join(', ')}`);
  if (references.chatConfiguration) locations.push('the current Chat configuration');
  if (references.activeChatTurns) locations.push('an active Chat turn');
  if (references.agents.length) locations.push(`Agent ${references.agents.map((agent) => `"${agent.agentName}"`).join(', ')}`);
  const prefix = `This MCP server is referenced by ${locations.join('; ')}.`;
  if (references.agents.length > 0 || references.activeChatTurns || references.chatConfiguration) {
    return `${prefix} Remove those references first (update_chat clears the Chat configuration declaration); force deletion cannot remove them.`;
  }
  if (force) return prefix;
  const cleanable = references.workflowDrafts.length > 0 || references.agentTeamRoles.length > 0;
  if (!cleanable) return `${prefix} Published Workflow versions and captured Team versions are immutable history; retry with force=true to delete the server while they keep their historical references.`;
  return `${prefix} Retry with force=true to remove the Workflow draft and Agent Team role references in place; published versions and captured Team versions keep their historical references.`;
}
