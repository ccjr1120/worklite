import { unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { StoredAgentCollaboration, StoredWorkflowDefinition, StoredWorkflowNode } from './schema';

const idFor = (workflowId: string, key: string) => `agt_${createHash('sha256').update(`${workflowId}:${key}`).digest('hex').slice(0, 32)}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];

/** Runs atomically at startup. Source rows are removed only after all configurations exist. */
export function migrateWorkflowsToAgents(client: BetterSqlite3.Database): void {
  client.transaction(() => {
    const workflows = client.prepare('SELECT id, workspace_id, name FROM workflows').all() as Array<{ id: string; workspace_id: string; name: string }>;
    const insert = client.prepare('INSERT INTO agents (id, workspace_id, kind, name, responsibility, system_prompt, provider_id, model, collaboration) VALUES (?, ?, \'custom\', ?, ?, ?, NULL, ?, ?)');
    for (const workflow of workflows) {
      const draft = client.prepare('SELECT definition FROM workflow_drafts WHERE workflow_id = ?').get(workflow.id) as { definition: string } | undefined;
      const version = client.prepare('SELECT definition, nodes FROM workflow_versions WHERE workflow_id = ? ORDER BY published DESC, version DESC LIMIT 1').get(workflow.id) as { definition: string | null; nodes: string } | undefined;
      // Invalid saved configuration must abort, rather than silently discarding the workflow.
      const definition = JSON.parse(draft?.definition ?? version?.definition ?? JSON.stringify({ nodes: JSON.parse(version?.nodes ?? '[]') })) as StoredWorkflowDefinition;
      if (!Array.isArray(definition.nodes)) throw new Error(`Cannot migrate ${workflow.name}: missing nodes.`);
      const nodes: Array<{ key: string; node: StoredWorkflowNode }> = [];
      const visit = (items: StoredWorkflowNode[], prefix = '') => {
        for (const node of items) {
          const key = `${prefix}${node.id}`;
          nodes.push({ key, node });
          const subgraph = record(record(node.config).subgraph);
          if (Array.isArray(subgraph.nodes)) visit(subgraph.nodes as StoredWorkflowNode[], `${key}/`);
        }
      };
      visit(definition.nodes);
      const specialists = nodes.filter(({ node }) => node.type === 'worklite/agent');
      const controls = new Set(['worklite/input', 'worklite/timer', 'worklite/map', 'worklite/join', 'worklite/branch', 'worklite/dashboard']);
      const capabilities = nodes.filter(({ node }) => node.type !== 'worklite/agent' && !controls.has(node.type)).map(({ key, node }) => ({ id: key, type: node.type, typeVersion: node.typeVersion, config: record(node.config) }));
      const subAgentIds = specialists.map(({ key }) => idFor(workflow.id, key));
      for (const { key, node } of specialists) {
        const config = record(node.config);
        const publicModels = typeof config.model === 'string' ? [config.model] : strings(config.model);
        const collaboration: StoredAgentCollaboration = {
          subAgentIds: [], capabilities: [], publicModels,
          outputFormat: config.outputFormat === 'json' ? 'json' : 'text', outputContract: config.outputContract,
          allowEmptyOutputKeys: strings(config.allowEmptyOutputKeys), requiredSkillIds: strings(config.requiredSkillIds),
          limits: Object.fromEntries(['maxToolCalls', 'maxToolRounds', 'maxToolResultChars', 'maxOutputTokens'].filter((name) => typeof config[name] === 'number').map((name) => [name, config[name]])),
        };
        const label = typeof config.label === 'string' ? config.label : 'Agent';
        insert.run(idFor(workflow.id, key), workflow.workspace_id, label, String(config.description ?? label), String(config.systemPrompt ?? ''), publicModels[0] ?? '', JSON.stringify(collaboration));
        for (const skillId of strings(config.skillIds)) client.prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) SELECT ?, id FROM skills WHERE id = ? AND workspace_id = ?').run(idFor(workflow.id, key), skillId, workflow.workspace_id);
        for (const serverId of strings(config.mcpServerIds)) client.prepare('INSERT OR IGNORE INTO agent_mcp_servers (agent_id, mcp_server_id) SELECT ?, id FROM mcp_servers WHERE id = ? AND workspace_id = ?').run(idFor(workflow.id, key), serverId, workflow.workspace_id);
      }
      const first = record(specialists[0]?.node.config);
      const publicModels = typeof first.model === 'string' ? [first.model] : strings(first.model);
      const prompt = [
        `You are the lead Agent for ${workflow.name}. Complete the user's goal by coordinating your specialist sub-Agents and available capabilities.`,
        'Choose the work, order, parallel batches and retries from actual results. There is no predefined graph or mandatory execution order. Pass each specialist the relevant task and context explicitly. For collections, choose the needed per-item calls yourself. Never claim success without tool evidence. Report failures and request the missing information when needed.',
        `Business responsibilities: ${nodes.map(({ node }) => { const c = record(node.config); return String(c.description ?? c.label ?? node.type); }).join('; ')}`,
        `Example request: ${JSON.stringify(definition.input?.example ?? null)}`,
      ].join('\n\n');
      insert.run(idFor(workflow.id, 'lead'), workflow.workspace_id, workflow.name, `Coordinate ${workflow.name}`, prompt, publicModels[0] ?? '', JSON.stringify({ subAgentIds, capabilities, publicModels } satisfies StoredAgentCollaboration));
      const schedule = client.prepare('SELECT interval_seconds, enabled, next_run_at FROM workflow_schedules WHERE workflow_id = ?').get(workflow.id) as { interval_seconds: number; enabled: number; next_run_at: number } | undefined;
      if (schedule) client.prepare('INSERT INTO scheduled_agent_tasks (id, workspace_id, agent_id, label, prompt, interval_seconds, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`sat_${workflow.id}`, workflow.workspace_id, idFor(workflow.id, 'lead'), workflow.name, typeof definition.input?.example === 'string' ? definition.input.example : JSON.stringify(definition.input?.example ?? {}), schedule.interval_seconds, schedule.enabled, schedule.next_run_at);
    }
    // No legacy definitions, versions, execution evidence or output Artifacts are retained.
    client.exec(`INSERT OR IGNORE INTO retired_workflow_artifact_files (object_key) SELECT object_key FROM artifacts WHERE (workflow_id IS NOT NULL OR run_id IS NOT NULL) AND object_key IS NOT NULL;
      DELETE FROM artifacts WHERE workflow_id IS NOT NULL OR run_id IS NOT NULL;
      DELETE FROM chat_submissions WHERE json_extract(target, '$.kind') = 'workflow' OR json_extract(reference, '$.kind') = 'workflow';
      DELETE FROM audit_logs WHERE action LIKE 'workflow%' OR action LIKE 'run.%' OR resource IN (SELECT id FROM workflow_runs);
      DELETE FROM workflow_schedules;
      DELETE FROM workflow_runs;
      DELETE FROM workflows;
      DELETE FROM home_board_categories;`);
  })();
  if (client.name !== ':memory:') {
    const files = client.prepare('SELECT object_key FROM retired_workflow_artifact_files').all() as Array<{ object_key: string }>;
    for (const file of files) {
      if (!/^artifacts\/art_[A-Za-z0-9-]+\.png$/.test(file.object_key)) continue;
      try { unlinkSync(resolve(dirname(client.name), file.object_key)); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      client.prepare('DELETE FROM retired_workflow_artifact_files WHERE object_key = ?').run(file.object_key);
    }
  }
}
