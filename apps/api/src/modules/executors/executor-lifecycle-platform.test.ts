import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, initializeDatabase, executorCategories, platformSkillPackageFiles } from '@worklite/db';
import { eq } from 'drizzle-orm';

describe('executor lifecycle platform integration', () => {
  it('exposes a creation tool and its script to Chat', () => {
    const files = new Map(platformSkillPackageFiles().map((file) => [file.path, file.content]));
    const tools = JSON.parse(files.get('scripts/tools.json')!) as Record<string, { name: string }>;
    expect(tools['scripts/create-executor.mjs']?.name).toBe('create_executor');
    expect(files.get('scripts/create-executor.mjs')).toContain("call('/executors', { method: 'POST', body })");
    expect(files.get('SKILL.md')).toContain('create_executor');
  });

  it('migrates existing Planner instructions without changing other roles or future edits', async () => {
    const db = createDb(':memory:');
    try {
      await initializeDatabase(db);
      db.insert(executorCategories).values({ id: 'migration-test', workspaceId: 'workspace_personal', name: 'Migration', description: '', processId: 'bmad-tea', processVersion: '1', roles: [
        { role: 'planner', instructions: 'Keep this instruction.', publicModelId: '', entryPoints: [], skills: [], mcpServers: [], toolNames: [] },
        { role: 'executor', instructions: 'Keep executor unchanged.', publicModelId: '', entryPoints: [], skills: [], mcpServers: [], toolNames: [] },
      ] }).run();
      db.$client.exec(readFileSync(resolve('packages/db/drizzle/0061_planner_evidence_policy.sql'), 'utf8'));
      const [migrated] = await db.select().from(executorCategories).where(eq(executorCategories.id, 'migration-test'));
      expect(migrated!.roles[0]!.instructions).toContain('Keep this instruction.');
      expect(migrated!.roles[0]!.instructions).toContain('Return waiting_for_input');
      expect(migrated!.roles[1]!.instructions).toBe('Keep executor unchanged.');
      db.update(executorCategories).set({ roles: [{ ...migrated!.roles[0]!, instructions: 'User-edited policy.' }, migrated!.roles[1]!] }).where(eq(executorCategories.id, 'migration-test')).run();
      await initializeDatabase(db);
      const [afterRestart] = await db.select().from(executorCategories).where(eq(executorCategories.id, 'migration-test'));
      expect(afterRestart!.roles[0]!.instructions).toBe('User-edited policy.');
    } finally {
      db.$client.close();
    }
  });
});
