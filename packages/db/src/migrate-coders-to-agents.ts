import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { StoredAgentCollaboration, StoredAgentTeamRoleConfiguration } from './schema';

const idFor = (coderId: string, role: string) => `agt_${createHash('sha256').update(`${coderId}:${role}`).digest('hex').slice(0, 32)}`;
const modelsOf = (value: string | string[]) => (Array.isArray(value) ? value : [value]).map((model) => model.trim()).filter(Boolean);

/** Converts configuration only. The old team scheduler, runs and role-task history are removed. */
export function migrateCodersToAgents(client: BetterSqlite3.Database): void {
  client.transaction(() => {
    const coders = client.prepare('SELECT id, workspace_id, name, description, roles, working_practice, project_git_policy FROM coders WHERE deleted_at IS NULL').all() as Array<{ id: string; workspace_id: string; name: string; description: string; roles: string; working_practice: string; project_git_policy: string }>;
    const insert = client.prepare("INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, runtime, model, provider_id, collaboration) VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?)");
    for (const coder of coders) {
      const roles = JSON.parse(coder.roles) as StoredAgentTeamRoleConfiguration[];
      if (!Array.isArray(roles)) throw new Error(`Cannot migrate ${coder.name}: invalid roles.`);
      const specialists = roles.filter((role) => role.role !== 'router');
      const subAgentIds = specialists.map((role) => idFor(coder.id, role.role));
      for (const role of specialists) {
        const models = modelsOf(role.publicModelId);
        const label = role.displayName || role.role;
        const collaboration: StoredAgentCollaboration = { subAgentIds: [], capabilities: [], publicModels: models, builtinToolNames: role.toolNames.filter((tool) => ['bash', 'read', 'write', 'glob', 'grep'].includes(tool)) };
        const runtime = role.executor ? { kind: role.executor, projectDirectory: '' } : { kind: 'native' };
        insert.run(idFor(coder.id, role.role), coder.workspace_id, label, `${coder.description}: ${label}`, [role.instructions, coder.working_practice, coder.project_git_policy, 'Complete the assigned task autonomously, follow the user and project instructions, and report your actual result. You are a sub-Agent; no Coding Team scheduler, fixed role order, handoff or Coder document protocol exists.'].filter(Boolean).join('\n\n'), JSON.stringify(runtime), models[0] ?? '', null, JSON.stringify(collaboration));
        for (const skill of role.skills ?? []) {
          client.prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) SELECT ?, id FROM skills WHERE id = ? AND workspace_id = ?').run(idFor(coder.id, role.role), skill.id, coder.workspace_id);
        }
        for (const server of role.mcpServers ?? []) client.prepare('INSERT OR IGNORE INTO agent_mcp_servers (agent_id, mcp_server_id) SELECT ?, id FROM mcp_servers WHERE id = ? AND workspace_id = ?').run(idFor(coder.id, role.role), server.id, coder.workspace_id);
      }
      const models = roles.flatMap((role) => modelsOf(role.publicModelId)).filter((model, index, all) => all.indexOf(model) === index).slice(0, 1);
      const chat = client.prepare("SELECT provider_id, model FROM agents WHERE workspace_id = ? AND id = 'agt_system_helper_chat'").get(coder.workspace_id) as { provider_id: string | null; model: string } | undefined;
      const prompt = [`You are the lead Agent for ${coder.name}. ${coder.description}`, 'Understand the complete user goal, inspect the project, choose the appropriate sub-Agents and coordinate them dynamically. Choose sequencing, independent parallel work, reviews and retries from results and task needs; no fixed Coding Team or server-owned Router workflow remains. Pass the full relevant task, project directory, context and findings to each sub-Agent. Report actual evidence, failures and unresolved questions.', coder.working_practice, coder.project_git_policy].filter(Boolean).join('\n\n');
      insert.run(idFor(coder.id, 'lead'), coder.workspace_id, coder.name, coder.description, prompt, JSON.stringify({ kind: 'native' }), models[0] ?? chat?.model ?? '', models.length ? null : chat?.provider_id ?? null, JSON.stringify({ subAgentIds, capabilities: [], publicModels: models } satisfies StoredAgentCollaboration));
    }
    client.exec(`DELETE FROM chat_submissions WHERE json_extract(target, '$.kind') = 'coder' OR json_extract(reference, '$.kind') = 'coder';
      DELETE FROM audit_logs WHERE action LIKE 'coder%' OR action LIKE 'agent_team%' OR resource IN (SELECT id FROM coder_runs);
      DELETE FROM coder_documents;
      DELETE FROM coder_operations;
      DELETE FROM coder_runs;
      DELETE FROM coder_versions;
      DELETE FROM coders;`);
  })();
  if (client.name !== ':memory:') {
    for (const directory of ['executor-categories', 'agent-teams']) for (const suffix of ['', '-wal', '-shm']) {
      rmSync(resolve(dirname(client.name), directory, `checkpoints.sqlite${suffix}`), { force: true });
    }
  }
}
