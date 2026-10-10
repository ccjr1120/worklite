import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type {
  ArtifactView,
  AuditEventView,
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
  CreateModelProviderRequest,
  CreateSkillRequest,
  CommandExecutionView,
  ExecuteSkillScriptRequest,
  ImportSkillRequest,
  McpServerTestResult,
  McpServerView,
  ModelProviderView,
  ModelProviderProtocol,
  SkillView,
  UpdateModelProviderRequest,
  UpdateWorkspaceSettingsRequest,
  UpdateSkillRequest,
  UsageRow,
  WorkspaceSettingsView,
} from '@worklite/contracts';
import {
  agentExecutions,
  agentMcpServers,
  agentTeams,
  agentTeamVersions,
  artifacts,
  agentSkills,
  agents,
  auditLogs,
  mcpServers,
  modelProviders,
  skillFiles,
  skills,
  workflowDrafts,
  workflowRuns,
  workflowSchedules,
  workflowVersions,
  wechatOfficialAccounts,
  workflows,
  workspaceSettings,
  type Database,
} from '@worklite/db';
import type { ModelProviderConfig } from '@worklite/model-gateway';
import { listWorkflowNodeCapabilities } from '@worklite/workflow-engine';
import { DATABASE } from '../../infrastructure/database.module';
import { WorkspaceService } from './teams.service';
import { SkillScriptRunnerService } from '../skills/skill-script-runner.service';
import { McpClientService } from '../mcp-servers/mcp-client.service';
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
  return { id: row.id, workspaceSlug, name: row.name, endpoint: row.endpoint, connection: row.connection, transport: 'Streamable HTTP', allowedTools: row.allowedTools, allowedToolNames: row.allowedToolNames ?? [], version: row.version, updatedAt: row.updatedAt.toISOString() };
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
  const common = { id: row.id, apiKey, baseURL: row.baseURL ?? undefined, headers: providerHeaders(row.headers) };
  if (row.protocol === 'anthropic/messages') return { ...common, adapter: 'anthropic', operation: 'messages' };
  if (row.protocol === 'codex/responses') return { ...common, adapter: 'codex', operation: 'responses' };
  if (row.protocol === 'openai/responses') return { ...common, adapter: 'openai', operation: 'responses' };
  if (row.protocol === 'openai/chat') return { ...common, adapter: 'openai', operation: 'chat/completions' };
  throw new BadRequestException('Unsupported model provider protocol.');
}

const CHAT_PLATFORM_SKILL_ID = 'sk_worklite_platform';

@Injectable()
export class WorkspaceResourcesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly skillScripts: SkillScriptRunnerService,
    private readonly mcpClient: McpClientService,
  ) {}

  async skills(request: Request, workspaceSlug: string): Promise<SkillView[]> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = (await this.db.select().from(skills).where(eq(skills.workspaceId, team.id)).orderBy(desc(skills.updatedAt))).filter((row) => row.id !== CHAT_PLATFORM_SKILL_ID);
    const files = rows.length === 0 ? [] : await this.db.select().from(skillFiles).where(inArray(skillFiles.skillId, rows.map((row) => row.id))).orderBy(asc(skillFiles.path));
    const bySkill = new Map<string, PackageFile[]>();
    for (const file of files) bySkill.set(file.skillId, [...(bySkill.get(file.skillId) ?? []), { path: file.path, content: file.content }]);
    return rows.map((row) => skillView(row, workspaceSlug, bySkill.get(row.id) ?? []));
  }

  async skill(request: Request, workspaceSlug: string, skillId: string): Promise<SkillView> {
    if (skillId === CHAT_PLATFORM_SKILL_ID) throw new NotFoundException('Skill not found');
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
    const [row] = await this.db.transaction((transaction) => {
      const inserted = transaction.insert(skills).values({ id, workspaceId: team.id, name, source: 'online', version: 'draft', validation: 'pending', instructions: files.find((file) => file.path === 'SKILL.md')?.content ?? '' }).returning().all();
      transaction.insert(skillFiles).values(files.map((file) => ({ skillId: id, ...file }))).run();
      return inserted;
    });
    if (!row) throw new NotFoundException('Skill could not be created');
    return skillView(row, workspaceSlug, files);
  }

  async importSkill(request: Request, workspaceSlug: string, input: ImportSkillRequest): Promise<SkillView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('Skill name is required.');
    const files = validatePackageFiles(input.files);
    const id = `sk_${randomUUID()}`;
    const [row] = await this.db.transaction((transaction) => {
      const inserted = transaction.insert(skills).values({ id, workspaceId: team.id, name, source: 'archive', version: 'draft', validation: 'pending', instructions: files.find((file) => file.path === 'SKILL.md')?.content ?? '' }).returning().all();
      transaction.insert(skillFiles).values(files.map((file) => ({ skillId: id, ...file }))).run();
      return inserted;
    });
    if (!row) throw new NotFoundException('Skill could not be imported');
    return skillView(row, workspaceSlug, files);
  }

  private async activeChatCapabilityIsReferenced(workspaceId: string, field: 'skills' | 'mcpServers', id: string) {
    const rows = await this.db.select({ snapshot: agentExecutions.capabilitySnapshot }).from(agentExecutions).where(and(eq(agentExecutions.workspaceId, workspaceId), inArray(agentExecutions.status, ['running', 'waiting_for_input'])));
    return rows.some(({ snapshot }) => snapshot?.[field].some((resource) => resource.id === id));
  }

  async deleteSkill(request: Request, workspaceSlug: string, skillId: string): Promise<void> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('Skill not found');
    if (existing.source === 'built-in') throw new BadRequestException('Built-in Skills cannot be deleted.');
    const [assignment] = await this.db.select({ agentId: agentSkills.agentId }).from(agentSkills).where(eq(agentSkills.skillId, skillId)).limit(1);
    if (assignment) throw new BadRequestException('Remove this Skill from every Agent before deleting it.');
    if (await this.activeChatCapabilityIsReferenced(team.id, 'skills', skillId)) throw new BadRequestException('This Skill is captured by an active Chat turn.');
    if (await this.workflowResourceIsReferenced(team.id, 'skillIds', skillId)) throw new BadRequestException('Remove this Skill from every Workflow draft and published version before deleting it.');
    if (await this.agentTeamResourceIsReferenced(team.id, 'skills', skillId)) throw new BadRequestException('Remove this Skill from every Agent Team configuration and captured Team version before deleting it.');
    await this.db.delete(skills).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id)));
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
    const [row] = await this.db.transaction((transaction) => {
      const updated = transaction.update(skills).set({ name, instructions: files.find((file) => file.path === 'SKILL.md')?.content ?? '', updatedAt: new Date() }).where(and(eq(skills.id, skillId), eq(skills.workspaceId, team.id))).returning().all();
      if (input.files !== undefined) {
        transaction.delete(skillFiles).where(eq(skillFiles.skillId, skillId)).run();
        transaction.insert(skillFiles).values(files.map((file) => ({ skillId, ...file }))).run();
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
    return rows.flatMap((server) => {
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
    const providers = await gatewayResponse.json() as Array<Pick<ModelProviderView, 'id' | 'name' | 'protocol'>>;
    const provider = providers.find((candidate) => candidate.name === providerName);
    if (!provider) throw new NotFoundException(`Model provider ${providerName} was not found.`);
    // A credential-forwarding protocol exchanges typed questions for typed
    // answers, so it cannot serve an Agent's system prompt and output format.
    if (provider.protocol === 'typesafe/systemone') throw new BadRequestException(`Model provider ${providerName} does not support Agent execution.`);
    return this.providerRuntime({} as Request, 'personal', provider.id, model);
  }

  async agentMcpRuntimes(request: Request, workspaceSlug: string, agentId: string): Promise<AgentMcpRuntime[]> {
    const workspace = await this.workspaces.getWorkspace(request, workspaceSlug);
    const rows = await this.db.select({ server: mcpServers }).from(agentMcpServers)
      .innerJoin(agents, eq(agentMcpServers.agentId, agents.id))
      .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
      .where(and(eq(agentMcpServers.agentId, agentId), eq(agents.workspaceId, workspace.id)));
    return rows.flatMap(({ server }) => {
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

  async deleteMcpServer(request: Request, workspaceSlug: string, serverId: string): Promise<void> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [existing] = await this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id))).limit(1);
    if (!existing) throw new NotFoundException('MCP server not found');
    const [assignment] = await this.db.select({ agentId: agentMcpServers.agentId }).from(agentMcpServers).where(eq(agentMcpServers.mcpServerId, serverId)).limit(1);
    if (assignment) throw new BadRequestException('Remove this MCP server from every Agent before deleting it.');
    if (await this.activeChatCapabilityIsReferenced(team.id, 'mcpServers', serverId)) throw new BadRequestException('This MCP server is captured by an active Chat turn.');
    if (await this.workflowResourceIsReferenced(team.id, 'mcpServerIds', serverId)) throw new BadRequestException('Remove this MCP server from every Workflow draft and published version before deleting it.');
    if (await this.agentTeamResourceIsReferenced(team.id, 'mcpServers', serverId)) throw new BadRequestException('Remove this MCP server from every Agent Team configuration and captured Team version before deleting it.');
    await this.db.delete(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, team.id)));
  }

  async createMcpServer(request: Request, workspaceSlug: string, input: CreateMcpServerRequest): Promise<McpServerView> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const allowedToolNames = normalizeToolNames(input.allowedTools);
    const [row] = await this.db.insert(mcpServers).values({ id: `mcp_${randomUUID()}`, workspaceId: team.id, name: input.name.trim(), endpoint: input.endpoint.trim(), authSecret: input.authToken ? encryptSecret(input.authToken) : null, connection: 'unconfigured', transport: 'Streamable HTTP', allowedTools: allowedToolNames.length, allowedToolNames, version: 'v1' }).returning();
    if (!row) throw new NotFoundException('MCP server could not be created');
    return mcpServerView(row, workspaceSlug);
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
      await this.db.update(mcpServers).set({ connection: 'connected', updatedAt: new Date() }).where(eq(mcpServers.id, server.id));
      return { connection: 'connected', tools: tools.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })) };
    } catch (error) {
      const failure = classifyMcpFailure(error);
      await this.db.update(mcpServers).set({ connection: failure.connection, updatedAt: new Date() }).where(eq(mcpServers.id, server.id));
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
    const [providerRows, skillRows, mcpRows, workflowRows, agentTeamRows, scheduleRows, settingsRows, officialAccountRows] = await Promise.all([
      this.providers(request, workspaceSlug),
      this.db.select().from(skills).where(and(eq(skills.workspaceId, workspace.id), ne(skills.id, CHAT_PLATFORM_SKILL_ID))).orderBy(skills.name),
      this.db.select().from(mcpServers).where(eq(mcpServers.workspaceId, workspace.id)).orderBy(mcpServers.name),
      this.db.select().from(workflows).where(eq(workflows.workspaceId, workspace.id)).orderBy(workflows.name),
      this.db.select().from(agentTeams).where(eq(agentTeams.workspaceId, workspace.id)).orderBy(agentTeams.name),
      this.db.select().from(workflowSchedules).where(eq(workflowSchedules.workspaceId, workspace.id)),
      this.db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspace.id)).limit(1),
      this.db.select({ id: wechatOfficialAccounts.id, displayName: wechatOfficialAccounts.displayName, status: wechatOfficialAccounts.status }).from(wechatOfficialAccounts).where(eq(wechatOfficialAccounts.workspaceId, workspace.id)),
    ]);
    const providerNames = new Map(providerRows.map((provider) => [provider.id, provider.name]));
    const skillNames = new Map(skillRows.map((skill) => [skill.id, skill.name]));
    const mcpNames = new Map(mcpRows.map((server) => [server.id, server.name]));

    return {
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      capabilities: {
        troubleshooting: {
          evidenceOwner: 'Chat',
          repairOwner: 'conversation-owned project task or collaborative Agent Team',
          chatHostTools: [], chatDirectTools: ['project_task', 'answer_project_task', 'cancel_project_task', 'update_plan', 'ask_user'], chatPlatformTools: 'one typed tool per protected worklite-platform script, declared in scripts/tools.json', chatCustomSkillsAndMcp: 'handed natively to the delegated project executor only',
          repairDispatchTool: 'dispatch_task',
          repairDispatchRoute: 'POST /chat/dispatch',
          repairIntake: 'project_task tool for independent Chat execution; existing Team intake for collaboration',
          inspectionAuthorizesRepair: false,
          gatewayLogs: {
            statistics: { tool: 'inspect_gateway_stats', route: 'GET /portkey-gateway/stats', retention: 'indefinite' },
            list: { tool: 'inspect_gateway_request_logs', route: 'GET /portkey-gateway/request-logs', filters: ['from', 'to', 'provider', 'model', 'statusClass', 'workflowRunId', 'teamRunId', 'limit', 'cursor'] },
            detail: { tool: 'inspect_gateway_request_log', route: 'GET /portkey-gateway/request-logs/:requestLogId', capture: 'complete stored request and response' },
            timeRange: 'explicit absolute from/to ISO-8601 instants',
            requestRetentionHours: 12,
            retentionMetadata: ['from', 'to', 'retainedFrom', 'retentionHours'],
            correlation: ['workflowRunId', 'nodeRunId', 'teamRunId', 'teamTaskAttemptId', 'teamOperationKey'],
            profile: 'server-owned WORKLITE_API_URL; no URL or profile override',
          },
        },
        runtimeProfiles: {
          development: { webPort: 3390, proxiedApiPort: 23391, gatewayPort: 23392, separateDatabase: false },
          deployment: { webPort: 23390, apiPort: 23391, gatewayPort: 23392 },
          sharedPersistentState: '.data/deployment',
        },
        chatShell: { available: false, historicalEvidence: 'existing Chat conversation records', uncertainRecovery: ['adopt_command', 'mark_failed'], automaticReplay: false },
        projectExecutors: { tool: 'project_task', executors: { codex: { pluginId: 'codex-cli-chat', transport: 'App Server stdio JSON-RPC', home: '~/.codex-cli', minimumVersion: '0.157.1', modelProtocols: ['openai/responses', 'codex/responses'], skills: 'skills/extraRoots/set', mcp: '-c mcp_servers with enabled_tools and env bearer token' }, claude: { pluginId: 'claude-code', transport: 'claude -p stream-json control protocol', configuration: '~/.claude', minimumVersion: '2.1.259', modelProtocols: ['anthropic/messages'], skills: '--plugin-dir', mcp: 'owner-only --mcp-config file plus --disallowedTools' } }, defaultExecutor: 'Chat configuration defaultExecutor (claude unless changed); Team developer role executor', removedLaunchModes: ['cxo'], gateway: 'both executors must reach the WorkLite Gateway', nativeTools: true, worklitePlatformToolsForExecutors: false, localConfiguration: 'complete operator configuration', approvals: 'none; executors run without approvals', operationJournal: false, uncertainRecovery: false, interruption: 'task fails without replay; inspect the project state', evidence: 'executor event stream activity, public reply text and process Command', progressText: 'latest complete public executor message; retained after cancellation or failure', chatTaskPrompt: 'task-specific prompt plus immutable user extension; pinned project instructions; previous evidence only on later attempts', capturedLaunch: true, olderSnapshots: 'new task or Run required', readRoute: 'GET /chat/project-tasks/:id', answerRoute: 'POST /chat/project-tasks/:id/answer', cancelRoute: 'POST /chat/project-tasks/:id/cancel', historicalOperationRoute: 'GET /chat/project-tasks/:id?operationKey=:operationKey', inspectTool: 'inspect_project_task', taskOwner: 'Chat conversation', execution: 'background dispatch-and-return; the turn settles at dispatch and settlement or a task question triggers one automatic report turn when the conversation idles', concurrency: 'one active task per project directory', controlTools: ['answer_project_task', 'cancel_project_task'], independentOfTeam: true, authorization: 'direct execution; no WorkLite proposal confirmation or command grants', automaticReplay: false, cancellation: 'Chat turn cancellation also cancels the conversation active background tasks' },
        chatCapabilities: { cancellation: { route: 'POST /agents/agt_system_helper_chat/executions/:executionId/cancel', states: ['running', 'waiting_for_input'], retained: ['messages', 'draft', 'execution evidence'], uncertainEffects: 'structured recovery; no automatic replay' }, orchestration: { directHostTools: false, customSkillExecution: false, directMcpCalls: false, platformTools: 'typed protected worklite-platform tools only', executorCapabilities: 'captured user Skill/MCP selections', codingTarget: 'project_task', localCommandTarget: 'project_task', collaborationTarget: 'team intake', automationTarget: 'published Workflow' }, newConversation: { intentOwner: 'Chat', presentation: 'request-bound button only', action: 'ask_user action new_conversation', submitRoute: 'POST /chat/dispatch', retainsHistory: true, cancelsDomainTasks: false }, configuration: 'revisioned user extensions', turnSnapshot: true, updatesApply: 'next user turn', configureRoute: 'PATCH /agents/agt_system_helper_chat' },
        upgrades: { operatorDeploymentVersion: { command: 'pnpm deploy:local', source: 'apps/web/package.json', bump: 'patch before compilation on every invocation', initialBaseline: 'established when current.json is absent after isolated preflight', laterDeployment: 'confirmed operator job through full managed upgrade flow', legacyTakeover: 'verified PID file, project start-local.mjs command, repository cwd, process group and target listeners only', unknownListeners: 'left untouched; deployment fails', failedAttempt: 'consumes source version; active build retains previous version', gitMutations: false, managedRelease: 'immutable manifest-bound version' }, proposeRoute: 'POST /upgrades', redeployRoute: 'POST /upgrades/redeploy', redeployTool: 'redeploy', inspectRoute: 'GET /upgrades/:id', authorization: 'explicit current Web or Feishu Chat user redeploy request; no second confirmation', authorizationBinding: 'persisted current user message and immutable release', deduplication: 'one job per execution and user message', profile: 'current managed runtime only; no model override', progress: 'original conversation; automatic observation after reconnect', requiresManagedBaseline: true, projectRoot: process.env.WORKLITE_PROJECT_ROOT ?? null, phases: ['proposed', 'authorized', 'preflighting', 'draining', 'frozen', 'switching', 'recovering', 'succeeded', 'rolled_back', 'failed'], uninterruptedIngress: false, interruptionPolicy: 'cancel active Agent, Team, Workflow and Command work after isolated preflight; never automatically resume after success or rollback' },
        chat: { workspaceRoute: '/chat', channelsRoute: 'GET /chat/channels', conversationsRoute: 'GET /chat/conversations', conversationRoute: 'GET /chat/conversations/:id', recordsRoute: 'GET /chat/conversations/:id/records', recordsSnapshots: 'latest snapshot plus all non-snapshot events', maxSkillScriptOutputChars: 60000, diagnosticTool: { name: 'inspect_chat_conversation', records: 'current evidence and status/receipt metadata; repeated snapshots and cards referenced', fullToolOutputInput: 'toolCallId', completeEvidence: 'fullRecordsRoute', inferenceHistory: 'raw replay snapshots replaced with explicit retained-evidence references; original history unchanged' }, channels: [{ id: 'web', builtIn: true, presentation: ['streaming', 'markdown', 'questions'] }, { id: 'feishu', builtIn: false, presentation: ['native streamed cards', 'collapsed task details', 'forms', 'QR images', 'files'] }], histories: 'server-persisted; unrelated conversations remain separate', backgroundConversations: { start: 'start_chat_conversation', monitor: ['wait_chat_conversation', 'inspect_chat_conversation'], reply: 'message_chat_conversation', userActivation: false, origin: 'first user message names the starting conversation', messaging: 'only conversations started from the current conversation', nesting: false, recoveryQuestions: 'user only' }, masterAgentId: 'agt_system_helper_chat', dispatchRoute: 'POST /chat/dispatch', taskFeedback: 'task state is independent of Chat turn; Team questions, failures and failed dispatches remain visible', teamIntakeParsing: 'explicit supported modes precede prose keywords; Chinese parentheses delimit directories', targets: ['conversation', 'team', 'workflow'], workflowVersions: 'published only', externalPluginId: 'feishu-bot', mergeHistories: false, webAccess: 'inspect and continue selected persisted conversation', feishu: { privateChat: true, defaultTarget: 'conversation', persistentTargetSelection: false, choices: 'current pending Agent question; plan not required', replyProgress: 'separate queued, thinking, responding and processing component in the same CardKit entity', cardPresentation: { transport: 'CardKit JSON 2.0 entity', requiredPermission: 'cardkit:card:write', replyAnimation: 'native fast typewriter', updates: 'component-local; full card for structural transitions', progressIcon: 'neutral native loading icon; no custom animation', taskDetails: 'default-collapsed Team task attempts and Workflow node execution statuses', visibleContext: ['current task or step', 'outcome', 'questions', 'failures', 'QR images', 'authorization forms', 'controls'], streamingLifecycle: 'model output only; close for tools, questions and terminal states; renew platform window', persistedDelivery: ['cardId', 'sequence', 'last delivered card', 'streaming start', 'pending idempotent UUID and exact payload'], legacyCardConversion: false }, completedDialogue: 'content without task header or completion label', taskAnswers: 'reply to the task card or submit its form', groupChat: false, inbound: ['text', 'card actions'], outbound: ['updated response cards', 'task questions and controls', 'QR images', 'Team documents', 'Workflow Artifacts'], configurationRoute: '/chat?view=channels', applicationRegistration: { available: true, archetype: 'PersonalAgent', startRoute: 'POST /plugins/feishu-bot/feishu/registration', cancelRoute: 'DELETE /plugins/feishu-bot/feishu/registration', operator: 'user through Web configuration', automaticCredentialPersistence: true, userBinding: 'automatic when returned, otherwise manual', resumable: true, manualExistingApplication: true, platformSetup: ['bot capability', 'IM permissions', 'long-connection message and card subscriptions', 'publication'], userOAuth: false, runtimeCompatibility: 'requires authorized real integration' } } },
        supportedResourceOperations: ['inspect Gateway statistics and request logs', 'delegate independent project work to a Codex or Claude Code project executor', 'inspect Chat project task activity', 'dispatch collaborative repair to Agent Team', 'inspect Chat conversations and full saved records', 'start, monitor and answer a background Chat conversation', 'inspect and update Chat capabilities', 'propose and inspect managed upgrades', 'redeploy WorkLite on explicit user request', 'inspect workspace resources', 'inspect Workflow capabilities', 'inspect and configure Agent Teams', 'inspect Agent Team conversations and documents', 'continue Agent Team Runs', 'dispatch Team intake and published Workflow tasks', 'navigate to known WorkLite pages and a Workflow editor by name or id', 'create non-secret model Provider draft', 'create Skill package', 'create remote MCP server draft', 'create Workflow draft', 'edit Workflow draft from a logical plan', 'publish Workflow draft', 'change appearance', 'change language'],
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
          teamCreation: false,
          teamDeletion: false,
          webRoute: `/agent-teams/${BUILT_IN_AGENT_TEAM_ID}`,
          webDefaultTab: 'conversation',
          chatDispatchesRuns: true,
          runWebRoute: '/agent-team-runs/:runId',
          builtInTeamId: BUILT_IN_AGENT_TEAM_ID,
          roles: [...AGENT_TEAM_ROLES],
          developerExecution: {
            executors: ['claude', 'codex'],
            roleField: 'executor (developer role only; default claude)',
            capturedLaunch: true,
            olderSnapshots: 'new Run required',
            nativeTools: true,
            operationJournal: false,
            processReferences: 'materialized read-only files listed in the task prompt',
            sharedExecutor: 'same project executors as Chat project tasks', commandAuthorization: 'direct execution; no WorkLite proposal confirmation or command grants',
            evidence: 'task.activity executor events and the executor process Command; Team owns final results',
          },
          multiDeveloper: {
            configuration: 'developer role developerInstances (up to 3 complete extra instances; omit preserves, explicit [] clears) and developerConcurrency (1-4)',
            reservedPrimaryId: 'developer',
            orchestrationVersion: 'new TeamVersions: 2 with developerExecutions map; version 1 snapshots keep the serial graph',
            taskKeys: 'development_<developerId> and repair_<round>_<developerId>; primary keeps historical keys',
            assignments: 'planner-produced non-overlapping ownedPaths; targeted repairRequests per developerId',
            retryBarrier: 'one retry resumes all failed assignments in the same fan-out; completed siblings never rerun',
            progress: 'run.progress events and run progress view: phase, next step, assignment completion, active developerIds; task events carry developerId and assignmentTitle; attempts carry progressText',
            pendingInputs: 'conversation view pendingInputs lists every waiting question; earliest remains the composer target',
          },
          modes: ['plan_only', 'validate_existing', 'implement_and_validate'],
          teamRoutes: {
            list: 'GET /agent-teams',
            detail: 'GET /agent-teams/:teamId',
            update: 'PATCH /agent-teams/:teamId',
            createRun: 'POST /agent-teams/:teamId/runs',
            conversation: 'GET /agent-teams/:teamId/conversation',
            sendConversationMessage: 'POST /agent-teams/:teamId/conversation/messages',
            conversationEvents: 'GET /agent-teams/:teamId/conversation/events',
          },
          conversation: {
            owner: 'Team',
            coordinatorMention: 'coordinator',
            intake: 'durable deterministic goal, directory, and mode collection',
            automaticRunCreation: 'conversation-origin Run starts exactly once after complete intake',
            queuedRequests: 'one active task per Team; later Coordinator requests queue',
            eventReplay: 'Last-Event-ID',
            chatAccess: 'inspection, continuation and shared server intake dispatch; no model-authored command grants',
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
          directRunCreationApi: true,
          commandAuthorization: 'non-developer roles: cumulative exact command strings; developer executor: direct native execution',
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
      agentTeams: agentTeamRows.map((team) => ({
        id: team.id,
        name: team.name,
        description: team.description,
        processId: team.processId,
        processVersion: team.processVersion,
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

  async deleteArtifact(request: Request, workspaceSlug: string, artifactId: string): Promise<void> {
    const team = await this.workspaces.getWorkspace(request, workspaceSlug);
    const [deleted] = await this.db.delete(artifacts).where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, team.id))).returning({ id: artifacts.id });
    if (!deleted) throw new NotFoundException('Artifact not found');
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

  private toArtifact(row: typeof artifacts.$inferSelect, workspaceSlug: string, workflowName: string): ArtifactView {
    return { id: row.id, workspaceSlug, name: row.name, type: row.type, workflowName, runId: row.runId ?? '', size: row.size, createdAt: row.createdAt.toISOString(), content: row.content };
  }
}
