import { resolveWorkflowNodeCapability } from '@worklite/workflow-engine';
import { BadRequestException, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { parse, stringify, YAMLParseError } from 'yaml';
import { agents, agentSkills, agentMcpServers, mcpServers, scheduledAgentTasks, skills, skillFiles, workspaces, type Database } from '@worklite/db';

export type AgentFileTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type AgentRow = typeof agents.$inferSelect;
export type AgentFileSkill = { id: string; name: string; instructions: string; version: string; validation: 'valid'; files: Array<{ path: string; content: string }> };
export type AgentFileEntry = { agent: AgentRow; directory: string; parentId: string | null; skills: AgentFileSkill[]; serverIds: string[] };
const stores = new WeakMap<Database, AgentFileStore>();
export const agentFiles = (db: Database) => stores.get(db);
export function initializeAgentFiles(db: Database, root = process.env.WORKLITE_AGENTS_DIR || join(homedir(), '.worklite', 'agents')) {
  const store = new AgentFileStore(db, root);
  store.initialize();
  stores.set(db, store);
  return store;
}

/** Files own configuration; database rows are a rebuildable index retaining historical foreign keys. */
export class AgentFileStore {
  readonly root: string;
  private entries = new Map<string, AgentFileEntry>();
  private readonly logger = new Logger(AgentFileStore.name);
  private readonly failures = new Map<string, Map<string, string>>();
  constructor(private readonly db: Database, root: string) { this.root = resolve(root); }

  workspaceRoot(workspaceId: string) {
    return workspaceId === 'workspace_personal' ? this.root : join(this.root, '.workspaces', slug(workspaceId));
  }

  initialize() {
    for (const workspace of this.db.select({ id: workspaces.id }).from(workspaces).all()) {
      const migrated = this.db.$client.prepare('SELECT root FROM agent_file_catalog_migrations WHERE workspace_id = ?').get(workspace.id) as { root: string } | undefined;
      const root = this.workspaceRoot(workspace.id);
      if (migrated && migrated.root !== root) throw new Error(`Agent files for ${workspace.id} live at ${migrated.root}; move the catalog explicitly before changing WORKLITE_AGENTS_DIR.`);
      if (!migrated) {
        if (existsSync(root) && readdirSync(root).some((name) => !name.startsWith('.'))) {
          // An existing manually authored tree is authoritative; never overwrite it from SQL.
          this.refresh(workspace.id);
        } else this.publish(workspace.id, this.rows(workspace.id), new Map());
        this.db.$client.prepare('INSERT INTO agent_file_catalog_migrations (workspace_id, root) VALUES (?, ?)').run(workspace.id, root);
      }
      this.refresh(workspace.id);
    }
  }

  private rows(workspaceId: string) { return this.db.select().from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.kind, 'custom'))).all(); }

  refresh(workspaceId: string, sourceRoot = this.workspaceRoot(workspaceId), project = true): AgentFileEntry[] {
    const found: AgentFileEntry[] = [];
    const root = sourceRoot;
    const visit = (base: string, parentId: string | null, depth: number, names?: string[]) => {
      if (!existsSync(base)) return;
      ensureDirectory(base);
      if (depth > 8) throw new BadRequestException('Agent nesting exceeds eight levels.');
      for (const name of names ?? readdirSync(base).sort()) {
        if (name.startsWith('.')) continue;
        const directory = join(base, name);
        ensureDirectory(directory);
        if (!existsSync(join(directory, 'AGENT.md'))) throw new BadRequestException(`Missing AGENT.md in ${directory}.`);
        const { config, body } = document(join(directory, 'AGENT.md'));
        const id = requiredString(config.id, 'Agent id');
        const runtime = record(config.runtime ?? { kind: 'native' });
        if (!['native', 'claude', 'codex'].includes(String(runtime.kind))) throw new BadRequestException(`Invalid runtime in ${directory}.`);
        if (runtime.kind !== 'native' && runtime.projectDirectory !== undefined && (typeof runtime.projectDirectory !== 'string' || (runtime.projectDirectory !== '' && !isAbsolute(runtime.projectDirectory)))) throw new BadRequestException('Agent projectDirectory must be absolute.');
        if (runtime.approvalPolicy !== undefined && !['auto', 'ask'].includes(String(runtime.approvalPolicy))) throw new BadRequestException('Invalid Agent approvalPolicy.');
        const collaboration = { ...record(config.collaboration), subAgentIds: [] as string[], capabilities: record(config.collaboration).capabilities ?? [] } as NonNullable<AgentRow['collaboration']>;
        if (record(config.collaboration).subAgentIds !== undefined || record(config.collaboration).privateTools !== undefined) throw new BadRequestException('Declare sub-Agents in subagents/ and private tools in tools/, not AGENT.md.');
        if (!Array.isArray(collaboration.capabilities)) throw new BadRequestException('Agent capabilities must be an array.');
        const capabilityIds = new Set<string>();
        for (const capability of collaboration.capabilities) {
          if (!capability || typeof capability.id !== 'string' || !capability.id.trim() || capabilityIds.has(capability.id) || !capability.config || typeof capability.config !== 'object' || Array.isArray(capability.config)) throw new BadRequestException(`Invalid or duplicate Agent capability in ${join(directory, 'AGENT.md')}.`);
          if (!resolveWorkflowNodeCapability(capability.type, capability.typeVersion)) throw new BadRequestException(`Unsupported Agent capability ${capability.type}@${capability.typeVersion} in ${join(directory, 'AGENT.md')}. Update the API to a version supporting this capability.`);
          capabilityIds.add(capability.id);
        }
        for (const key of ['publicModels', 'builtinToolNames', 'requiredSkillIds', 'outputContract', 'allowEmptyOutputKeys'] as const) if (collaboration[key] !== undefined) stringArray(collaboration[key], key);
        if (collaboration.builtinToolNames?.some((name) => !['bash', 'read', 'write', 'glob', 'grep'].includes(name))) throw new BadRequestException('Invalid built-in tool name.');
        if (collaboration.outputFormat !== undefined && !['text', 'json'].includes(collaboration.outputFormat)) throw new BadRequestException('Invalid Agent outputFormat.');
        for (const value of Object.values(collaboration.limits ?? {})) if (!Number.isSafeInteger(value) || value < 1) throw new BadRequestException('Agent limits must be positive integers.');
        const privateTools = readTools(join(directory, 'tools'));
        for (const tool of privateTools) { const handler = tool.handler; if (handler.kind === 'capability' && !collaboration.capabilities.some((item) => item.id === handler.capabilityId)) throw new BadRequestException('Private tool capability must belong to its Agent.'); }
        if (privateTools.length) collaboration.privateTools = privateTools;
        const assignedSkills = readSkills(join(directory, 'skills'), id);
        if (runtime.kind !== 'native' && (privateTools.length || collaboration.capabilities.length || existsSync(join(directory, 'subagents')) && readdirSync(join(directory, 'subagents')).some((name) => !name.startsWith('.')))) throw new BadRequestException('An execution adapter cannot own sub-Agents or private capability tools.');
        const previous = this.db.select().from(agents).where(eq(agents.id, id)).get();
        if (previous && (previous.workspaceId !== workspaceId || previous.kind !== 'custom')) throw new BadRequestException('An Agent file id conflicts with an existing workspace or system Agent.');
        const agent: AgentRow = { id, workspaceId, kind: 'custom', name: requiredString(config.name, 'Agent name'), responsibility: optionalString(config.responsibility, ''), model: optionalString(config.model, ''), providerId: config.providerId == null ? null : requiredString(config.providerId, 'providerId'), systemPrompt: body, runtime: runtime as AgentRow['runtime'], collaboration, createdAt: previous?.createdAt ?? new Date(), updatedAt: previous?.updatedAt ?? new Date() };
        const entry = { agent, directory, parentId, skills: assignedSkills, serverIds: stringArray(config.mcpServerIds ?? [], 'mcpServerIds') };
        found.push(entry);
        visit(join(directory, 'subagents'), id, depth + 1);
        collaboration.subAgentIds = found.filter((item) => item.parentId === id).map((item) => item.agent.id);
      }
    };
    const validate = (entries: AgentFileEntry[]) => {
      if (new Set(entries.map((entry) => entry.agent.id)).size !== entries.length) throw new BadRequestException('Duplicate Agent id in file catalog.');
      for (const entry of entries) {
        for (const serverId of entry.serverIds) if (!this.db.select().from(mcpServers).where(and(eq(mcpServers.id, serverId), eq(mcpServers.workspaceId, workspaceId))).get()) throw new BadRequestException('Assigned MCP server is unavailable in this workspace.');
        if (new Set(entry.skills.map((skill) => skill.id)).size !== entry.skills.length) throw new BadRequestException('Duplicate Skill id inside Agent package.');
      }
    };
    if (!project) {
      // Publishing is strict: never replace files with an incomplete catalog.
      visit(root, null, 0);
      validate(found);
      return found;
    }
    const failures = new Map<string, string>();
    if (existsSync(root)) {
      ensureDirectory(root);
      for (const name of readdirSync(root).sort().filter((name) => !name.startsWith('.'))) {
        const start = found.length;
        try {
          visit(root, null, 0, [name]);
          validate(found.slice(start));
        } catch (error) {
          if (!(error instanceof BadRequestException) && !(error instanceof YAMLParseError) && !(error instanceof Error && 'code' in error)) throw error;
          found.splice(start);
          failures.set(join(root, name), error instanceof Error ? error.message : String(error));
        }
      }
    }
    // Ambiguous identities invalidate every owning package, regardless of scan order.
    const counts = new Map<string, number>();
    for (const entry of found) counts.set(entry.agent.id, (counts.get(entry.agent.id) ?? 0) + 1);
    const packageRoot = (entry: AgentFileEntry) => join(root, relative(root, entry.directory).split(sep)[0]!);
    for (const entry of found) if (counts.get(entry.agent.id)! > 1) failures.set(packageRoot(entry), 'Duplicate Agent id in file catalog.');
    for (let index = found.length - 1; index >= 0; index--) if (failures.has(packageRoot(found[index]!))) found.splice(index, 1);
    for (const [path, message] of failures) if (this.failures.get(workspaceId)?.get(path) !== message) this.logger.warn(`Agent package unavailable: ${path}: ${message}`);
    this.failures.set(workspaceId, failures);
    // Validate the whole tree before replacing any index rows. Missing files stay absent from the catalog.
    this.db.transaction((tx) => {
      for (const entry of found) {
        const previous = tx.select().from(agents).where(eq(agents.id, entry.agent.id)).get();
        const serverIds = tx.select().from(agentMcpServers).where(eq(agentMcpServers.agentId, entry.agent.id)).all().map((row) => row.mcpServerId);
        if (JSON.stringify(serverIds.sort()) !== JSON.stringify([...entry.serverIds].sort())) {
          tx.delete(agentMcpServers).where(eq(agentMcpServers.agentId, entry.agent.id)).run();
          // New Agent rows are inserted below before their server assignments.
        }
        if (previous && signature(previous) === signature(entry.agent)) {
          if (serverIds.length !== entry.serverIds.length || serverIds.some((id) => !entry.serverIds.includes(id))) {
            if (entry.serverIds.length) tx.insert(agentMcpServers).values(entry.serverIds.map((mcpServerId) => ({ agentId: entry.agent.id, mcpServerId }))).run();
          }
          continue;
        }
        entry.agent.updatedAt = new Date();
        tx.insert(agents).values(entry.agent).onConflictDoUpdate({ target: agents.id, set: { ...entry.agent } }).run();
        if (serverIds.length !== entry.serverIds.length || serverIds.some((id) => !entry.serverIds.includes(id))) {
          if (entry.serverIds.length) tx.insert(agentMcpServers).values(entry.serverIds.map((mcpServerId) => ({ agentId: entry.agent.id, mcpServerId }))).run();
        }
      }
    });
    for (const [id, entry] of this.entries) if (entry.agent.workspaceId === workspaceId) this.entries.delete(id);
    for (const entry of found) this.entries.set(entry.agent.id, entry);
    return found;
  }

  get(id: string) { return this.entries.get(id); }
  list(workspaceId: string) { return this.refresh(workspaceId).filter((entry) => !entry.parentId); }

  mutate<T>(workspaceId: string, mutation: (tx: AgentFileTransaction) => T, skillSelections = new Map<string, string[]>(), excludedIds = new Set<string>()) {
    this.refresh(workspaceId, this.workspaceRoot(workspaceId), false);
    const before = new Map(this.refresh(workspaceId).map((entry) => [entry.agent.id, entry]));
    const beforeRows = new Set(this.rows(workspaceId).map((row) => row.id));
    let backup: string | undefined;
    try {
      const result = this.db.transaction((tx) => {
        const result = mutation(tx);
        const rows = this.rows(workspaceId).filter((row) => !excludedIds.has(row.id) && (before.has(row.id) || !beforeRows.has(row.id)));
        backup = this.publish(workspaceId, rows, before, skillSelections, true);
        return result;
      });
      if (backup) rmSync(backup, { recursive: true, force: true });
      this.refresh(workspaceId);
      return result;
    } catch (error) {
      if (backup && existsSync(backup)) { rmSync(this.workspaceRoot(workspaceId), { recursive: true, force: true }); renameSync(backup, this.workspaceRoot(workspaceId)); }
      throw error;
    }
  }

  remove(workspaceId: string, agentId: string, parentAgentId?: string) {
    this.mutate(workspaceId, (tx) => {
      if (parentAgentId) {
        const parent = tx.select().from(agents).where(eq(agents.id, parentAgentId)).get()!;
        tx.update(agents).set({ collaboration: { ...parent.collaboration!, subAgentIds: parent.collaboration!.subAgentIds.filter((id) => id !== agentId) } }).where(eq(agents.id, parentAgentId)).run();
      }
      tx.update(scheduledAgentTasks).set({ enabled: false, running: false }).where(eq(scheduledAgentTasks.agentId, agentId)).run();
      // Retain the Agent index row and every execution/session foreign key for historical evidence.
    }, undefined, new Set([agentId]));
  }

  /** Persist provider model maintenance through the same file source, rather than changing SQL alone. */
  updateModels(workspaceId: string, providerId: string, model: string, allowedModels?: string[]) {
    this.mutate(workspaceId, (tx) => {
      for (const row of this.rows(workspaceId)) if (row.providerId === providerId && (!allowedModels || !allowedModels.includes(row.model))) tx.update(agents).set({ model, ...(allowedModels ? {} : { providerId: null }), updatedAt: new Date() }).where(eq(agents.id, row.id)).run();
    });
  }

  private publish(workspaceId: string, rows: AgentRow[], previous: Map<string, AgentFileEntry>, selections = new Map<string, string[]>(), keepBackup = false): string | undefined {
    const root = this.workspaceRoot(workspaceId);
    mkdirSync(dirname(root), { recursive: true });
    const stage = `${root}.stage-${randomUUID()}`;
    const backup = `${root}.backup-${randomUUID()}`;
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const owners = new Map<string, string>();
    for (const row of rows) for (const child of row.collaboration?.subAgentIds ?? []) {
      if (!byId.has(child) || owners.has(child)) throw new BadRequestException('Each sub-Agent must exist and belong to exactly one parent.');
      owners.set(child, row.id);
    }
    const written = new Set<string>();
    const write = (row: AgentRow, base: string, depth: number) => {
      if (depth > 8 || written.has(row.id)) throw new BadRequestException('Agent assignments contain a cycle or exceed eight levels.');
      written.add(row.id);
      let name = slug(row.name);
      if (existsSync(join(base, name))) name += `-${slug(row.id)}`;
      const directory = join(base, name);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const old = previous.get(row.id);
      if (old) for (const name of readdirSync(old.directory)) {
        if (['subagents', 'skills', 'tools', 'AGENT.md'].includes(name)) continue;
        const path = join(old.directory, name);
        ensureSafeTree(path);
        cpSync(path, join(directory, name), { recursive: true });
      }
      const { subAgentIds: _children, privateTools, ...collaboration } = row.collaboration ?? { subAgentIds: [], capabilities: [] };
      const serverIds = this.db.select().from(agentMcpServers).where(eq(agentMcpServers.agentId, row.id)).all().map((item) => item.mcpServerId);
      writeDocument(join(directory, 'AGENT.md'), { id: row.id, name: row.name, responsibility: row.responsibility, runtime: row.runtime, providerId: row.providerId, model: row.model, mcpServerIds: serverIds, collaboration }, row.systemPrompt);
      mkdirSync(join(directory, 'skills'), { mode: 0o700 });
      mkdirSync(join(directory, 'tools'), { mode: 0o700 });
      if (old && existsSync(join(old.directory, 'tools'))) for (const name of readdirSync(join(old.directory, 'tools'))) {
        if (/\.ya?ml$/.test(name)) continue;
        const source = join(old.directory, 'tools', name); ensureSafeTree(source);
        cpSync(source, join(directory, 'tools', name), { recursive: true });
      }
      const selected = selections.get(row.id);
      const packages = selected === undefined && old ? old.skills : this.assignedSkills(row.id, selected);
      for (const skill of packages) {
        const skillDirectory = join(directory, 'skills', `${slug(skill.name)}-${hash(skill.id)}`);
        mkdirSync(skillDirectory, { recursive: true, mode: 0o700 });
        for (const file of skill.files.filter((file) => file.path !== 'SKILL.md')) writeInside(skillDirectory, file.path, file.content);
        // Keep original Skill frontmatter/body and its stable id when copied from the shared catalog.
        const original = splitDocument(skill.instructions);
        writeDocument(join(skillDirectory, 'SKILL.md'), { ...original.config, id: skill.id, name: skill.name, version: skill.version }, original.body);
      }
      for (const tool of privateTools ?? []) writeFileSync(join(directory, 'tools', `${slug(tool.name)}.yaml`), stringify(tool), { mode: 0o600 });
      mkdirSync(join(directory, 'subagents'), { mode: 0o700 });
      for (const child of row.collaboration?.subAgentIds ?? []) write(byId.get(child)!, join(directory, 'subagents'), depth + 1);
    };
    let moved = false;
    try {
      // Preserve catalogs of additional workspaces, without exposing them as top-level Agents.
      if (workspaceId === 'workspace_personal' && existsSync(join(root, '.workspaces'))) cpSync(join(root, '.workspaces'), join(stage, '.workspaces'), { recursive: true });
      for (const row of rows) if (!owners.has(row.id)) write(row, stage, 0);
      if (written.size !== rows.length) throw new BadRequestException('Agent assignments contain a cycle.');
      this.refresh(workspaceId, stage, false);
      if (existsSync(root)) { renameSync(root, backup); moved = true; }
      renameSync(stage, root);
      if (moved && !keepBackup) rmSync(backup, { recursive: true, force: true });
      return moved && keepBackup ? backup : undefined;
    } catch (error) {
      if (moved && !existsSync(root)) renameSync(backup, root);
      throw error;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }

  private assignedSkills(agentId: string, selected?: string[]): AgentFileSkill[] {
    const ids = selected ?? this.db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId)).all().map((item) => item.skillId);
    return ids.map((id) => {
      const skill = this.db.select().from(skills).where(eq(skills.id, id)).get();
      const owned = this.entries.get(agentId)?.skills.find((skill) => skill.id === id);
      if (owned) return owned;
      if (!skill || skill.validation !== 'valid') throw new BadRequestException(`Assigned Skill ${id} is unavailable or invalid.`);
      const files = this.db.select({ path: skillFiles.path, content: skillFiles.content }).from(skillFiles).where(eq(skillFiles.skillId, id)).all();
      return { id, name: skill.name, version: skill.version, instructions: skill.instructions, validation: 'valid', files: files.some((file) => file.path === 'SKILL.md') ? files : [{ path: 'SKILL.md', content: skill.instructions }, ...files] };
    });
  }
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 8); }
function slug(value: string) { return value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 90) || 'agent'; }
function requiredString(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${name} must be nonempty text.`); return value; }
function optionalString(value: unknown, fallback: string) { if (value === undefined) return fallback; if (typeof value !== 'string') throw new BadRequestException('Agent metadata must be text.'); return value; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) throw new BadRequestException(`${name} must contain unique strings.`); return value; }
function record(value: unknown): Record<string, unknown> { if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected a YAML mapping.'); return value as Record<string, unknown>; }
function ensureDirectory(path: string) { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BadRequestException(`Agent catalog entries must be real directories: ${path}.`); }
function ensureSafeTree(path: string) { const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new BadRequestException(`Symbolic links are not allowed in Agent packages: ${path}.`); if (stat.isDirectory()) for (const name of readdirSync(path)) ensureSafeTree(join(path, name)); }
function readText(path: string) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw new BadRequestException(`Invalid or oversized Agent file: ${path}.`); return readFileSync(path, 'utf8'); }
function splitDocument(text: string) { const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); return match ? { config: record(parse(match[1]!, { maxAliasCount: 0 })), body: text.slice(match[0].length).replace(/^\r?\n/, '') } : { config: {}, body: text }; }
function document(path: string) { const text = readText(path); if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) throw new BadRequestException(`Missing or incomplete YAML frontmatter in ${path}.`); try { return splitDocument(text); } catch { throw new BadRequestException(`Invalid YAML frontmatter in ${path}.`); } }
function writeDocument(path: string, config: Record<string, unknown>, body: string) { writeFileSync(path, `---\n${stringify(config)}---\n\n${body}`, { mode: 0o600 }); }
function writeInside(root: string, path: string, content: string) { const target = resolve(root, path); if (!relative(root, target) || relative(root, target) === '..' || relative(root, target).startsWith(`..${sep}`) || isAbsolute(relative(root, target))) throw new BadRequestException('Skill file path escapes its package.'); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { mode: content.startsWith('#!') ? 0o700 : 0o600 }); }
function readSkills(root: string, agentId: string): AgentFileSkill[] {
  if (!existsSync(root)) return [];
  ensureDirectory(root);
  return readdirSync(root).filter((name) => !name.startsWith('.')).sort().map((name) => {
    const directory = join(root, name); ensureDirectory(directory);
    const { config } = document(join(directory, 'SKILL.md'));
    const files: Array<{ path: string; content: string }> = [];
    const visit = (base: string) => { for (const name of readdirSync(base).sort()) { const path = join(base, name); const stat = lstatSync(path); if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path); else files.push({ path: relative(directory, path).split(sep).join('/'), content: readText(path) }); } };
    visit(directory);
    return { id: config.id === undefined ? `ask_${hash(`${agentId}/${name}`)}` : requiredString(config.id, 'Skill id'), name: optionalString(config.name, name), version: optionalString(config.version, 'local'), instructions: readText(join(directory, 'SKILL.md')), validation: 'valid', files };
  });
}
function readTools(root: string): NonNullable<AgentRow['collaboration']>['privateTools'] & object {
  if (!existsSync(root)) return [];
  ensureDirectory(root);
  const tools = readdirSync(root).filter((name) => !name.startsWith('.') && /\.ya?ml$/.test(name)).sort().map((name) => record(parse(readText(join(root, name)), { maxAliasCount: 0 })));
  const reserved = new Set(['run_sub_agent', 'run_sub_agents', 'pause_sub_agent', 'resume_sub_agent', 'wait_sub_agent', 'use_sub_agent_tool', 'use_capability', 'read_result', 'store_result', 'bash', 'read', 'write', 'glob', 'grep', 'skill_script', 'mcp', 'control_agent_instance', 'process_reference', 'read_coder_document', 'update_plan', 'ask_user']);
  const names = new Set<string>();
  for (const tool of tools) {
    const name = requiredString(tool.name, 'Tool name');
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || reserved.has(name) || names.has(name)) throw new BadRequestException('Private tool name is reserved, invalid or duplicated.');
    names.add(name); requiredString(tool.description, 'Tool description');
    if (record(tool.inputSchema).type !== 'object') throw new BadRequestException('Tool inputSchema must be an object schema.');
    const handler = record(tool.handler);
    if (handler.kind === 'command') { requiredString(handler.command, 'Tool command'); if (!isAbsolute(requiredString(handler.workingDirectory, 'Tool workingDirectory'))) throw new BadRequestException('Tool workingDirectory must be absolute.'); }
    else if (handler.kind === 'capability') requiredString(handler.capabilityId, 'Tool capabilityId');
    else throw new BadRequestException('Unknown private tool handler.');
  }
  return tools as NonNullable<AgentRow['collaboration']>['privateTools'] & object;
}
function signature(row: AgentRow) { return JSON.stringify([row.id, row.workspaceId, row.kind, row.name, row.responsibility, row.model, row.providerId, row.systemPrompt, row.runtime, row.collaboration]); }
