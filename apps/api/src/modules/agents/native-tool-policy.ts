import type { GatewayToolDefinition } from '@worklite/model-gateway';
import type { NativeToolPolicy } from './native-agent-loop';

export function nativeToolPolicy(workspaceId: string, name: string, input: unknown, definition?: GatewayToolDefinition): NativeToolPolicy {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (definition?.concurrency) {
    const { namespace, keyFields } = definition.concurrency;
    const values = keyFields.map((field) => value[field]);
    // Incomplete resource identities force sequential execution within the batch.
    const key = values.every((entry) => typeof entry === 'string' && entry.length) ? JSON.stringify(values) : '*';
    return { mode: key === '*' ? 'sequential' : definition.executionMode ?? 'parallel', resourceKeys: [`${workspaceId}:${namespace}:${key}`] };
  }
  if (definition?.executionMode === 'sequential') return { mode: 'sequential' };
  if (/^(update|delete|remove|configure)_agent$/.test(name) && typeof value.agentId === 'string') {
    return { mode: 'parallel', resourceKeys: [`${workspaceId}:agent:${JSON.stringify([value.agentId])}`] };
  }
  if (/^(update|delete|remove|configure)_/.test(name)) {
    const identity = ['skillId', 'providerId', 'mcpServerId', 'projectId', 'connectionId'].find((key) => typeof value[key] === 'string');
    if (identity) return { mode: 'parallel', resourceKeys: [`${workspaceId}:${identity}:${JSON.stringify(value[identity])}`] };
  }
  if (name === 'run_agent' && typeof value.executionId === 'string') return { mode: 'parallel', resourceKeys: [`${workspaceId}:execution:${value.executionId}`] };
  if (definition?.executionMode === 'parallel' || /^(inspect|list|get|search|read|fetch)_/.test(name) || ['run_host_command', 'run_agent', 'web_fetch'].includes(name)) return { mode: 'parallel' };
  // Unknown operations may mutate shared state. Their owner can explicitly opt into parallel execution.
  return { mode: 'sequential', resourceKeys: [`${workspaceId}:platform-mutation`] };
}
