import { createHash } from 'node:crypto';
import type { AgentTeamOperationJournal, AgentTeamOperationRecord } from './types';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function stableInputFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function teamOperationKey(request: {
  taskKey: string;
  operationKey: string;
}): string {
  return `${request.taskKey}:${request.operationKey}`;
}

export async function findReplayableOperation(
  journal: AgentTeamOperationJournal,
  request: {
    taskKey: string;
    operationKey: string;
    inputFingerprint: string;
  },
): Promise<AgentTeamOperationRecord | undefined> {
  const operationKey = teamOperationKey(request);
  const record = await journal.findOperation(operationKey);
  if (!record) return undefined;
  if (
    record.taskKey !== request.taskKey ||
    record.operationKey !== request.operationKey ||
    record.inputFingerprint !== request.inputFingerprint
  ) {
    throw new Error(`Operation ${operationKey} was persisted for different input.`);
  }
  return record.status === 'completed' ? record : undefined;
}
