import type { StoredAgentModelMessage } from './schema';

export type StoredAgentToolResult = Extract<StoredAgentModelMessage, { role: 'tool' }>['content'][number];

const MISSING_TOOL_RESULT = 'The previous tool attempt did not complete and its result was missing from stored history.';

function assistantIndexes(messages: readonly StoredAgentModelMessage[]): Map<string, number> {
  const indexes = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const part of message.content) {
      if (part.type === 'tool-call') indexes.set(part.toolCallId, index);
    }
  });
  return indexes;
}

export function insertAgentToolResults(messages: readonly StoredAgentModelMessage[], results: readonly StoredAgentToolResult[]): StoredAgentModelMessage[] {
  if (results.length === 0) return [...messages];
  const indexes = assistantIndexes(messages);
  const grouped = new Map<number, StoredAgentToolResult[]>();
  for (const result of results) {
    const index = indexes.get(result.toolCallId);
    if (index === undefined) throw new Error(`Agent tool result ${result.toolCallId} has no matching tool call.`);
    grouped.set(index, [...(grouped.get(index) ?? []), result]);
  }
  const normalized = [...messages];
  for (const [index, group] of [...grouped.entries()].sort((left, right) => right[0] - left[0])) {
    const following = normalized[index + 1];
    if (following?.role === 'tool') normalized.splice(index + 1, 1, { role: 'tool', content: [...following.content, ...group] });
    else normalized.splice(index + 1, 0, { role: 'tool', content: group });
  }
  return normalized;
}

export function normalizeAgentModelMessages(messages: readonly StoredAgentModelMessage[]): StoredAgentModelMessage[] {
  const calls = new Map<string, { index: number; toolName: string; result?: StoredAgentToolResult }>();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const part of message.content) {
      if (part.type === 'tool-call' && !calls.has(part.toolCallId)) calls.set(part.toolCallId, { index, toolName: part.toolName });
    }
  });
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const result of message.content) {
      const call = calls.get(result.toolCallId);
      if (call && !call.result) call.result = result;
    }
  }
  const grouped = new Map<number, StoredAgentToolResult[]>();
  for (const [toolCallId, call] of calls) {
    const result = call.result ?? { type: 'tool-result' as const, toolCallId, toolName: call.toolName, output: { type: 'error-text' as const, value: MISSING_TOOL_RESULT } };
    grouped.set(call.index, [...(grouped.get(call.index) ?? []), result]);
  }
  const normalized: StoredAgentModelMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'tool') return;
    normalized.push(message);
    if (message.role !== 'assistant') return;
    const results = grouped.get(index);
    if (results?.length) normalized.push({ role: 'tool', content: results });
  });
  return normalized;
}
