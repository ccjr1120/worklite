import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, initializeDatabase } from './client';
import * as schema from './schema';
import type { Database } from './client';

let db: Database | undefined;

afterEach(() => {
  db?.$client.close();
  db = undefined;
});

describe('initializeDatabase restart recovery', () => {
  it('closes a non-recoverable running tool call and persists its failure result', async () => {
    db = createDb(':memory:');
    await initializeDatabase(db);

    const executionId = 'aex_restart_test';
    db.insert(schema.agentExecutions).values({
      id: executionId,
      workspaceId: 'workspace_personal',
      agentId: 'agt_system_helper_chat',
      modelMessages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_restart_test', toolName: 'inspect_workspace', input: {} }] },
      ],
      displayMessages: [],
      plan: [],
    }).run();
    db.insert(schema.agentToolCalls).values({
      id: 'acall_restart_test',
      executionId,
      workspaceId: 'workspace_personal',
      agentId: 'agt_system_helper_chat',
      toolCallId: 'call_restart_test',
      toolName: 'builtin',
      mcpToolName: 'inspect_workspace',
      workingDirectory: '/',
      arguments: [],
      packageFiles: [],
      output: '',
      resultAppended: false,
    }).run();

    await initializeDatabase(db);

    const [recoveredExecution] = db.select().from(schema.agentExecutions).where(eq(schema.agentExecutions.id, executionId)).limit(1).all();
    const [recoveredCall] = db.select().from(schema.agentToolCalls).where(eq(schema.agentToolCalls.id, 'acall_restart_test')).limit(1).all();

    expect(recoveredExecution.status).toBe('failed');
    expect(recoveredExecution.errorCode).toBe('restarted');
    expect(recoveredCall.status).toBe('failed');
    expect(recoveredCall.resultAppended).toBe(true);
    expect(recoveredCall.output).toBe('The API restarted before this Agent tool execution completed.');
    expect(recoveredExecution.modelMessages).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_restart_test', toolName: 'inspect_workspace', input: {} }] },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_restart_test',
          toolName: 'inspect_workspace',
          output: { type: 'error-text', value: 'The API restarted before this Agent tool execution completed.' },
        }],
      },
    ]);
  });
});
