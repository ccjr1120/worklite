import { agentExecutionColumns, agentExecutions, createDb, initializeDatabase } from '@worklite/db';
import { ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { AgentExecutionsService } from './agent-executions.service';
import type { ChatProgressReport } from '@worklite/contracts';
import { executionFailure } from './agent-execution-failure';

describe('progress reports when the Gateway is unavailable', () => {
  it('preserves a completed conversation and emits the known task status', async () => {
    const db = createDb(':memory:');
    try {
      await initializeDatabase(db);
      const id = 'aex_gateway_fallback';
      db.insert(agentExecutions).values({ id, workspaceId: 'workspace_personal', agentId: 'agt_system_helper_chat', status: 'running', modelMessages: [{ role: 'user', content: 'progress' }], capabilitySnapshot: { agent: { id: 'agt_system_helper_chat', providerId: 'provider', model: 'model', systemPrompt: 'Chat' }, skills: [] } as never }).run();
      const unused = {} as never;
      const service = new AgentExecutionsService(db, { getWorkspace: async () => ({ id: 'workspace_personal' }) } as never, { providerRuntime: async () => { throw new ServiceUnavailableException('Portkey Gateway is unavailable.'); } } as never, unused, { discover: async () => [] } as never, unused, unused, unused, { list: () => [] } as never, unused, unused, { notify: () => {} } as never, unused);
      const report = { items: [{ kind: 'coder' as const, id: 'run_1', title: 'Coding task', status: 'running' }] };
      await (service as unknown as { advance(request: unknown, slug: string, id: string, report: ChatProgressReport): Promise<unknown> }).advance({}, 'personal', id, report);
      const row = db.select(agentExecutionColumns).from(agentExecutions).where(eq(agentExecutions.id, id)).get()!;
      expect(row.status).toBe('completed');
      expect(row.error).toBeNull();
      expect(row.displayMessages.at(-1)?.content).toContain('Coding task：running');
    } finally { db.$client.close(); }
  });
  it('reports Gateway outages accurately for ordinary model turns', () => {
    expect(executionFailure(new ServiceUnavailableException('Portkey Gateway is unavailable.')).code).toBe('provider_request');
  });
});
