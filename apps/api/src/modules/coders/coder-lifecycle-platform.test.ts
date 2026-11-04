import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, coders, agents, platformSkillPackageFiles } from '@worklite/db';
import { eq } from 'drizzle-orm';

describe('Coder lifecycle platform integration', () => {
  it('replaces the retired creation tool with Agent management', () => {
    const files = new Map(platformSkillPackageFiles().map((file) => [file.path, file.content]));
    const tools = JSON.parse(files.get('scripts/tools.json')!) as Record<string, { name: string }>;
    expect(tools['scripts/create-coder.mjs']).toBeUndefined();
    expect(tools['scripts/create-agent.mjs']?.name).toBe('create_agent');
    expect(files.has('scripts/create-coder.mjs')).toBe(false);
    expect(files.get('SKILL.md')).toContain('create_agent');
  });

  it('keeps edited role instructions when converting team configurations to Agents', async () => {
    const db = createDb(':memory:');
    try {
      await initializeDatabase(db);
      db.insert(coders).values({ id: 'migration-test', workspaceId: 'workspace_personal', name: 'Migration', description: '', processId: 'bmad-tea', processVersion: '1', roles: [
        { role: 'planner', instructions: 'Keep this instruction.', publicModelId: '', entryPoints: [], skills: [], mcpServers: [], toolNames: [] },
        { role: 'implementer', instructions: 'Keep implementer unchanged.', publicModelId: '', entryPoints: [], skills: [], mcpServers: [], toolNames: [] },
      ] }).run();
      // 0061 predates the Coder rename (0063) and targets the old table name.
      db.$client.exec(readFileSync(resolve('packages/db/drizzle/0061_planner_evidence_policy.sql'), 'utf8').replaceAll('executor_categories', 'coders'));
      const [migrated] = await db.select().from(coders).where(eq(coders.id, 'migration-test'));
      expect(migrated!.roles[0]!.instructions).toContain('Keep this instruction.');
      expect(migrated!.roles[0]!.instructions).toContain('Return waiting_for_input');
      expect(migrated!.roles[1]!.instructions).toBe('Keep implementer unchanged.');
      db.update(coders).set({ roles: [{ ...migrated!.roles[0]!, instructions: 'User-edited policy.' }, migrated!.roles[1]!] }).where(eq(coders.id, 'migration-test')).run();
      await initializeDatabase(db);
      expect(await db.select().from(coders).where(eq(coders.id, 'migration-test'))).toEqual([]);
      const converted = await db.select().from(agents);
      expect(converted.find((agent) => agent.name === 'planner')?.systemPrompt).toContain('User-edited policy.');
      expect(converted.find((agent) => agent.name === 'implementer')?.systemPrompt).toContain('Keep implementer unchanged.');
    } finally {
      db.$client.close();
    }
  });
});
