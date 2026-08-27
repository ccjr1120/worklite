import { BadRequestException, Inject, Injectable, NotFoundException, RequestTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  ArtifactView,
  AuditEventView,
  CreateMcpServerRequest,
  CreateModelProviderRequest,
  CreateSkillRequest,
  CommandExecutionView,
  ExecuteSkillScriptRequest,
  McpServerView,
  ModelProviderView,
  ModelProviderTestResult,
  SkillView,
  UpdateWorkspaceSettingsRequest,
  UpdateSkillRequest,
  UsageRow,
  WorkliteNavigationTarget,
  WorkspaceSettingsView,
} from '@worklite/contracts';
import {
  artifacts,
  agentMcpServers,
  agentSkills,
  agents,
  auditLogs,
  mcpServers,
  modelProviders,
  skillFiles,
  skills,
  workflowRuns,
  workflows,
  workspaceSettings,
  type Database,
} from '@worklite/db';
import { createModelGateway, type ModelProviderConfig } from '@worklite/model-gateway';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from './teams.service';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';

function maskSecret(value: string): string {
  return value.length > 4 ? `****${value.slice(-4)}` : '****';
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

function providerView(row: typeof modelProviders.$inferSelect): ModelProviderView {
  return { id: row.id, name: row.name, kind: row.kind, baseUrl: row.baseUrl, organization: row.organization, project: row.project, status: row.status, maskedKey: row.maskedKey, models: row.models ?? [], headerNames: headerNames(row.headers) };
}

type PackageFile = { path: string; content: string };

const MAX_SKILL_FILES = 100;
const MAX_SKILL_FILE_BYTES = 256 * 1_024;
const MAX_SKILL_PACKAGE_BYTES = 1 * 1_024 * 1_024;

const WORKLITE_NAVIGATION_ROUTES = {
  home: '/home',
  agents: '/agents',
  'system-helper-chat': '/agents/agt_system_helper_chat',
  skills: '/skills',
  'mcp-servers': '/mcp-servers',
  'model-providers': '/model-providers',
  workflows: '/workflows',
  runs: '/runs',
  artifacts: '/artifacts',
  'settings-appearance': '/settings/appearance',
  'settings-usage': '/settings/usage',
  'settings-audit-log': '/settings/audit-log',
} as const satisfies Record<WorkliteNavigationTarget, string>;

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

function skillView(row: typeof skills.$inferSelect, workspaceSlug: string, files: PackageFile[]): SkillView {
  return {
    id: row.id,
    workspaceSlug,
    name: row.name,
    source: row.source,
    version: row.version,
    validation: row.validation,
    files,
    updatedAt: row.updatedAt.toISOString(),
  };
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
  const common = { id: row.id, apiKey, baseUrl: row.baseUrl ?? undefined, headers: providerHeaders(row.headers) };
  if (row.kind === 'deepseek') return { ...common, kind: 'deepseek' };
  return { ...common, kind: row.kind, organization: row.organization ?? undefined, project: row.project ?? undefined };
}

// Fixed multilingual smoke-test prompt requested by the product.
const PROVIDER_TEST_PROMPT = '\u4f60\u597d';

@Injectable()
export class WorkspaceResourcesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly skillScripts: SkillScriptRunnerService,
  ) {}

  async skills(request: Request, workspaceSlug: string): Promise<SkillView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(skills).where(eq(skills.workspaceId, team.id)).orderBy(desc(skills.updatedAt));
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    const bySkill = new Map<string, PackageFile[]>();
    for (const file of files) bySkill.set(file.skillId, [...(bySkill.get(file.skillId) ?? []), { path: file.path, content: file.content }]);
    return rows.map((row) => skillView(row, workspaceSlug, bySkill.get(row.id) ?? []));
  }

  async skill(request: Request, workspaceSlug: string, skillId: string): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Skill not found');
    const files = await this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, row.id)).orderBy(asc(skillFiles.path));
    return skillView(row, workspaceSlug, files);
  }

  async createSkill(request: Request, workspaceSlug: string, input: CreateSkillRequest): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Skill name is required.');
    if (input.source !== undefined && input.source !== 'online') throw new BadRequestException('Archive Skill creation is not available yet.');
    const files = validatePackageFiles(input.files);
    const id = `sk_${randomUUID()}`;
    const [row] = await this.db.transaction(async (transaction) => {
      const inserted = await transaction.insert(skills).values({ id, workspaceId: team.id, name, source: 'online', version: 'draft', validation: 'pending', instructions: files.find((file) => file.path === 'SKILL.md')?.content ?? '' }).returning();
      await transaction.insert(skillFiles).values(files.map((file) => ({ skillId: id, ...file })));
      return inserted;
    });
    if (!row) throw new NotFoundException('Skill could not be created');
    return skillView(row, workspaceSlug, files);
  }

  async updateSkill(request: Request, workspaceSlug: string, skillId: string, input: UpdateSkillRequest): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Skill not found');
    if (existing.source === 'built-in') throw new BadRequestException('Built-in Skills cannot be changed.');
    if (Object.keys(input).some((key) => key !== 'name' && key !== 'files')) throw new BadRequestException('Only the Skill name and package files can be changed.');
    const name = input.name === undefined ? existing.name : input.name.trim();
    if (!name) throw new BadRequestException('Skill name is required.');
    const files = input.files === undefined
      ? await this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, skillId)).orderBy(asc(skillFiles.path))
      : validatePackageFiles(input.files);
    const [row] = await this.db.transaction(async (transaction) => {
      const updated = await transaction.update(skills).set({ name, instructions: files.find((file) => file.path === 'SKILL.md')?.content ?? '', updatedAt: new Date() }).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).returning();
      if (input.files !== undefined) {
        await transaction.delete(skillFiles).where(eq(skillFiles.skillId, skillId));
        await transaction.insert(skillFiles).values(files.map((file) => ({ skillId, ...file })));
      }
      return updated;
    });
    if (!row) throw new NotFoundException('Skill not found');
    return skillView(row, workspaceSlug, files);
  }

  async executeSkillScript(request: Request, workspaceSlug: string, skillId: string, input: ExecuteSkillScriptRequest): Promise<CommandExecutionView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [skill] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!skill) throw new NotFoundException('Skill not found');
    if (!input || typeof input.scriptPath !== 'string' || !Array.isArray(input.arguments) || input.arguments.some((argument) => typeof argument !== 'string')) {
      throw new BadRequestException('A Skill script path and string argument array are required.');
    }
    const files = await this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, skillId)).orderBy(asc(skillFiles.path));
    return this.skillScripts.start(files, input.scriptPath, input.arguments);
  }

  async mcpServers(request: Request, workspaceSlug: string): Promise<McpServerView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, team.id)).orderBy(desc(mcpServers.updatedAt));
    return rows.map((row) => ({ id: row.id, workspaceSlug, name: row.name, connection: row.connection, transport: 'Streamable HTTP', allowedTools: row.allowedTools, version: row.version, updatedAt: row.updatedAt.toISOString() }));
  }

  async mcpServer(request: Request, workspaceSlug: string, serverId: string): Promise<McpServerView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('MCP server not found');
    return { id: row.id, workspaceSlug, name: row.name, connection: row.connection, transport: 'Streamable HTTP', allowedTools: row.allowedTools, version: row.version, updatedAt: row.updatedAt.toISOString() };
  }

  async createMcpServer(request: Request, workspaceSlug: string, input: CreateMcpServerRequest): Promise<McpServerView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.insert(mcpServers).values({ id: `mcp_${randomUUID()}`, workspaceId: team.id, name: input.name.trim(), endpoint: input.endpoint.trim(), authSecret: input.authToken ? encryptSecret(input.authToken) : null, connection: 'unconfigured', transport: 'Streamable HTTP', allowedTools: 0, version: 'v1' }).returning();
    if (!row) throw new NotFoundException('MCP server could not be created');
    return { id: row.id, workspaceSlug, name: row.name, connection: row.connection, transport: 'Streamable HTTP', allowedTools: row.allowedTools, version: row.version, updatedAt: row.updatedAt.toISOString() };
  }

  async providers(request: Request, workspaceSlug: string): Promise<ModelProviderView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select().from(modelProviders).where(eq(modelProviders.workspaceId, team.id)).orderBy(modelProviders.name);
    return rows.map(providerView);
  }

  async platformSnapshot(request: Request, workspaceSlug: string) {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [providerRows, skillRows, mcpRows, agentRows, workflowRows, settingsRows, agentSkillRows, agentMcpRows] = await Promise.all([
      this.db.select().from(modelProviders).where(eq(modelProviders.workspaceId, workspace.id)).orderBy(modelProviders.name),
      this.db.select().from(skills).where(eq(skills.workspaceId, workspace.id)).orderBy(skills.name),
      this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspace.id)).orderBy(mcpServers.name),
      this.db.select().from(agents).where(eq(agents.workspaceId, workspace.id)).orderBy(agents.name),
      this.db.select().from(workflows).where(eq(workflows.workspaceId, workspace.id)).orderBy(workflows.name),
      this.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspace.id)).limit(1),
      this.db.select({ agentId: agentSkills.agentId, skillId: agentSkills.skillId }).from(agentSkills).innerJoin(agents, eq(agentSkills.agentId, agents.id)).where(eq(agents.workspaceId, workspace.id)),
      this.db.select({ agentId: agentMcpServers.agentId, mcpServerId: agentMcpServers.mcpServerId }).from(agentMcpServers).innerJoin(agents, eq(agentMcpServers.agentId, agents.id)).where(eq(agents.workspaceId, workspace.id)),
    ]);
    const providerNames = new Map(providerRows.map((provider) => [provider.id, provider.name]));
    const skillNames = new Map(skillRows.map((skill) => [skill.id, skill.name]));
    const mcpNames = new Map(mcpRows.map((server) => [server.id, server.name]));

    return {
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      capabilities: {
        supportedResourceOperations: ['inspect workspace resources', 'navigate to known WorkLite pages', 'create non-secret model Provider draft', 'create Skill package', 'create remote MCP server draft', 'create Agent draft', 'create Workflow draft', 'change appearance', 'change language'],
        requiresExplicitConfirmation: true,
        mcpToolNamesAvailable: false,
        mcpToolDataNote: 'Only the allowed-tool count is persisted. Do not invent or infer MCP tool names.',
      },
      modelProviders: providerRows.map((provider) => ({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        status: provider.status,
        models: provider.models ?? [],
      })),
      skills: skillRows.map((skill) => ({
        id: skill.id,
        name: skill.name,
        source: skill.source,
        version: skill.version,
        validation: skill.validation,
      })),
      mcpServers: mcpRows.map((server) => ({
        id: server.id,
        name: server.name,
        connection: server.connection,
        transport: server.transport,
        allowedToolCount: server.allowedTools,
        version: server.version,
      })),
      agents: agentRows.map((agent) => ({
        id: agent.id,
        kind: agent.kind,
        name: agent.name,
        responsibility: agent.responsibility,
        providerId: agent.providerId,
        providerName: agent.providerId ? providerNames.get(agent.providerId) ?? null : null,
        model: agent.model,
        skills: agentSkillRows.filter((assignment) => assignment.agentId === agent.id).map((assignment) => ({ id: assignment.skillId, name: skillNames.get(assignment.skillId) ?? assignment.skillId })),
        mcpServers: agentMcpRows.filter((assignment) => assignment.agentId === agent.id).map((assignment) => ({ id: assignment.mcpServerId, name: mcpNames.get(assignment.mcpServerId) ?? assignment.mcpServerId })),
      })),
      workflows: workflowRows.map((workflow) => ({ id: workflow.id, name: workflow.name, state: workflow.state })),
      settings: settingsRows[0] ? { appearance: settingsRows[0].appearance, locale: settingsRows[0].locale } : null,
    };
  }

  async settings(request: Request, workspaceSlug: string): Promise<WorkspaceSettingsView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspace.id)).limit(1);
    if (!row) throw new NotFoundException('Workspace settings not found');
    return { appearance: row.appearance, locale: row.locale, updatedAt: row.updatedAt.toISOString() };
  }

  async updateSettings(request: Request, workspaceSlug: string, input: UpdateWorkspaceSettingsRequest): Promise<WorkspaceSettingsView> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Workspace settings must be an object.');
    if (Object.keys(input).some((key) => key !== 'appearance' && key !== 'locale')) throw new BadRequestException('Only appearance and locale can be changed.');
    if (input.appearance !== undefined && input.appearance !== 'system' && input.appearance !== 'light' && input.appearance !== 'dark') throw new BadRequestException('Unsupported appearance preference.');
    if (input.locale !== undefined && input.locale !== 'en' && input.locale !== 'zh-CN') throw new BadRequestException('Unsupported locale preference.');
    if (input.appearance === undefined && input.locale === undefined) throw new BadRequestException('At least one workspace setting is required.');
    const [row] = await this.db.update(workspaceSettings).set({
      ...(input.appearance === undefined ? {} : { appearance: input.appearance }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      updatedAt: new Date(),
    }).where(eq(workspaceSettings.workspaceId, workspace.id)).returning();
    if (!row) throw new NotFoundException('Workspace settings not found');
    return { appearance: row.appearance, locale: row.locale, updatedAt: row.updatedAt.toISOString() };
  }

  async resolveNavigation(request: Request, workspaceSlug: string, input: { target?: unknown }) {
    await this.workspaces.getWorkspace(request, workspaceSlug);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'target')) throw new BadRequestException('A navigation target is required.');
    const route = WORKLITE_NAVIGATION_ROUTES[input.target as WorkliteNavigationTarget];
    if (!route) throw new BadRequestException('Unsupported WorkLite navigation target.');
    return { type: 'navigation' as const, target: input.target as WorkliteNavigationTarget, route };
  }

  async upsertProvider(request: Request, workspaceSlug: string, input: CreateModelProviderRequest): Promise<ModelProviderView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name.trim();
    if (!name) throw new BadRequestException('Provider name is required.');
    const kind = input.kind ?? 'openai-compatible';
    const validKinds = new Set(['deepseek', 'openai', 'openai-compatible']);
    if (!validKinds.has(kind)) throw new BadRequestException('Unsupported model provider kind.');
    const headers = normalizeHeaders(input.headers);
    const serializedHeaders = headers === undefined ? undefined : encryptSecret(JSON.stringify(headers));
    const baseUrl = input.baseUrl?.trim() || null;
    const organization = input.organization?.trim() || null;
    const project = input.project?.trim() || null;
    const models = input.models?.map((model) => model.trim()).filter(Boolean);
    const [existing] = await this.db.select().from(modelProviders).where(and(eq(modelProviders.workspaceId, team.id), eq(modelProviders.name, name))).limit(1);
    const apiKey = input.apiKey?.trim();
    const [row] = existing
      ? await this.db.update(modelProviders).set({ kind, baseUrl, organization, project, ...(apiKey ? { apiKey: encryptSecret(apiKey), maskedKey: maskSecret(apiKey), status: 'connected' as const } : {}), ...(models ? { models } : {}), ...(serializedHeaders !== undefined ? { headers: serializedHeaders } : {}), updatedAt: new Date() }).where(eq(modelProviders.id, existing.id)).returning()
      : await this.db.insert(modelProviders).values({ id: `prov_${randomUUID()}`, workspaceId: team.id, name, kind, baseUrl, organization, project, apiKey: apiKey ? encryptSecret(apiKey) : null, maskedKey: apiKey ? maskSecret(apiKey) : '', status: apiKey ? 'connected' : 'unconfigured', models: models ?? [], headers: serializedHeaders ?? null }).returning();
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

  async testProvider(request: Request, workspaceSlug: string, providerId: string): Promise<ModelProviderTestResult> {
    const runtime = await this.providerRuntime(request, workspaceSlug, providerId);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30_000);
    try {
      const result = createModelGateway().streamText({
        provider: runtime.provider,
        model: runtime.model,
        messages: [{ role: 'user', content: PROVIDER_TEST_PROMPT }],
        temperature: 0,
        maxOutputTokens: 256,
        abortSignal: abortController.signal,
      });
      const response = (await result.result).text.trim();
      if (!response) throw new Error('Empty model response');
      return { prompt: PROVIDER_TEST_PROMPT, model: runtime.model, response };
    } catch {
      if (abortController.signal.aborted) throw new RequestTimeoutException('Model provider test timed out after 30 seconds.');
      throw new ServiceUnavailableException('Model provider test failed. Check the API key, endpoint, custom headers, and model id.');
    } finally {
      clearTimeout(timeout);
    }
  }

  async providerRuntime(
    request: Request,
    workspaceSlug: string,
    providerId: string,
    selectedModel?: string,
  ): Promise<{ provider: ModelProviderConfig; model: string }> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select().from(modelProviders).where(and(eq(modelProviders.id, providerId), eq(modelProviders.workspaceId, workspace.id))).limit(1);
    if (!row) throw new NotFoundException('Model provider not found');
    const configuredModels = (row.models ?? []).map((value) => value.trim()).filter(Boolean);
    const model = (selectedModel?.trim() || configuredModels[0]);
    if (!model) throw new BadRequestException('Add at least one model id before using this provider.');
    if (selectedModel && !configuredModels.includes(model)) throw new BadRequestException('The selected model is not configured for this provider.');
    if (!row.apiKey) throw new BadRequestException('Add an API key before using this provider.');
    return { provider: providerConfig(row, decryptSecret(row.apiKey)), model };
  }

  async deleteProvider(request: Request, workspaceSlug: string, providerId: string): Promise<void> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    await this.db.update(agents).set({ providerId: null, model: '', updatedAt: new Date() }).where(and(eq(agents.workspaceId, team.id), eq(agents.providerId, providerId)));
    const [row] = await this.db.delete(modelProviders)
      .where(and(eq(modelProviders.id, providerId), eq(modelProviders.workspaceId, team.id)))
      .returning({ id: modelProviders.id });
    if (!row) throw new NotFoundException('Model provider not found');
  }

  async artifactsList(request: Request, workspaceSlug: string): Promise<ArtifactView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ artifact: artifacts, workflowName: workflows.name }).from(artifacts).leftJoin(workflows, eq(artifacts.workflowId, workflows.id)).where(eq(artifacts.workspaceId, team.id)).orderBy(desc(artifacts.createdAt));
    return rows.map(({ artifact, workflowName }) => this.toArtifact(artifact, workspaceSlug, workflowName ?? 'Unknown workflow'));
  }

  async artifact(request: Request, workspaceSlug: string, artifactId: string): Promise<ArtifactView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [row] = await this.db.select({ artifact: artifacts, workflowName: workflows.name }).from(artifacts).leftJoin(workflows, eq(artifacts.workflowId, workflows.id)).where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, team.id))).limit(1);
    if (!row) throw new NotFoundException('Artifact not found');
    return this.toArtifact(row.artifact, workspaceSlug, row.workflowName ?? 'Unknown workflow');
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

  private toArtifact(row: typeof artifacts.$inferSelect, workspaceSlug: string, workflowName: string): ArtifactView {
    return { id: row.id, workspaceSlug, name: row.name, type: row.type, workflowName, runId: row.runId ?? '', size: row.size, createdAt: row.createdAt.toISOString(), content: row.content };
  }
}
