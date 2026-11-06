import type { AgentExecutionPhase, AgentExecutionStatus, AgentToolCallView } from '@worklite/contracts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function agentInvocationDisplays(
  calls: Array<{ id: string; mcpToolName: string | null; input: unknown; createdAt: Date }>,
  rows: Array<{ id: string; metadata: unknown }>,
  agents: Array<{ id: string; name: string }>,
  backgroundExecutions: Array<{ id: string; status: AgentExecutionStatus; phase: AgentExecutionPhase }> = [],
  ownerStatus?: AgentExecutionStatus,
): Map<string, NonNullable<AgentToolCallView['agentInvocation']>> {
  const result = new Map<string, NonNullable<AgentToolCallView['agentInvocation']>>();
  const runs = rows.map((row): Record<string, unknown> & { id: string } => ({ ...record(row.metadata), id: row.id })).filter((run) => !run.parentRunId);
  const dispatches = calls.filter((call) => call.mcpToolName === 'run_agent');
  for (const [index, call] of dispatches.entries()) {
    const input = record(call.input);
    if (typeof input.agentId !== 'string') continue;
    const task = typeof input.task === 'string' ? input.task : input.task == null ? '' : JSON.stringify(input.task);
    const background = backgroundExecutions.find((execution) => execution.id === input.__backgroundExecutionId);
    const state = background ? { status: background.status, phase: background.phase } : {};
    if (typeof input.__backgroundExecutionId === 'string' && typeof input.__agentInvocationId === 'string' && typeof input.__agentName === 'string') {
      result.set(call.id, { agentId: input.agentId, agentName: input.__agentName, runId: input.__agentInvocationId, task, ...state });
      continue;
    }
    const next = dispatches[index + 1];
    // Older calls predate explicit invocation binding. Match only within this dispatch's
    // time interval, never a child invocation or a later dispatch of the same Agent.
    const run = runs.find((item) => item.agentId === input.agentId && item.id === input.__agentInvocationId)
      ?? runs.find((item) => item.agentId === input.agentId && typeof item.createdAt === 'string' && Date.parse(item.createdAt) >= call.createdAt.getTime() && (!next || Date.parse(item.createdAt) < next.createdAt.getTime()));
    const recordedStatus = run?.status;
    let historicalStatus = typeof recordedStatus === 'string' && ['running', 'waiting_for_input', 'paused', 'completed', 'failed', 'cancelled'].includes(recordedStatus)
      ? recordedStatus as AgentExecutionStatus | 'paused' : undefined;
    if (historicalStatus && ['running', 'waiting_for_input', 'paused'].includes(historicalStatus) && (ownerStatus === 'failed' || ownerStatus === 'cancelled')) historicalStatus = ownerStatus;
    const name = typeof run?.agentName === 'string' ? run.agentName : agents.find((agent) => agent.id === input.agentId)?.name;
    if (name) result.set(call.id, { agentId: input.agentId, agentName: name, runId: run?.id ?? call.id, task: task || (typeof run?.task === 'string' ? run.task : ''), ...(historicalStatus ? { status: historicalStatus } : {}), ...state });
  }
  return result;
}
