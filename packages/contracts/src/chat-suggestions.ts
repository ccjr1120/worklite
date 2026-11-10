import type { AgentExecutionView, AgentToolCallView } from './index';

export type ChatSuggestion = { id: string; text: string; runIds: string[] };
export type ChatSuggestionResponse = {
  contextVersion: string;
  suggestion: ChatSuggestion | null;
  source: 'rules' | 'jev';
};

type Invocation = NonNullable<AgentToolCallView['agentInvocation']>;

const singleLine = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit);

/** Shared by the UI and API: a poll or tool-phase change alone is not a new recommendation. */
export function chatSuggestionContext(execution: AgentExecutionView) {
  const latest = new Map<string, Invocation>();
  for (const call of execution.toolCalls) {
    if (call.agentInvocation) latest.set(call.agentInvocation.runId, call.agentInvocation);
  }
  const tasks = [...latest.values()].filter((task) => task.status === 'running' || task.status === 'waiting_for_input')
    .map(({ runId, agentId, agentName, task, status }) => ({ runId, agentId, agentName, task: singleLine(task, 240), status }));
  // The composer also accepts queued follow-ups while Chat is replying. Keep that
  // turn's streaming assistant text out of the decision context until it settles.
  let lastUserIndex = execution.messages.length - 1;
  while (lastUserIndex >= 0 && execution.messages[lastUserIndex]?.role !== 'user') lastUserIndex--;
  const stableMessages = execution.status === 'running' ? execution.messages.slice(0, lastUserIndex + 1) : execution.messages;
  const messages = stableMessages.filter((message) => message.kind !== 'summary_divider' && message.content.trim())
    .slice(-4).map(({ role, content }) => ({ role, content: singleLine(content, 400) }));
  const signature = JSON.stringify([execution.id, Boolean(execution.pendingQuestion), tasks, messages]);
  // An opaque freshness token, never an authorization token. Two independent accumulators
  // keep it small without sending another copy of the conversation in every request.
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < signature.length; index++) {
    first = Math.imul(first ^ signature.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ signature.charCodeAt(index);
  }
  const contextVersion = `v1-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
  const candidates: ChatSuggestion[] = [];
  if (!execution.pendingQuestion) {
    const recentUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const ranked = tasks.map((task, index) => ({ task, score: (task.status === 'waiting_for_input' ? 100 : 0)
      + (recentUser.includes(task.agentName) ? 20 : 0) + index / Math.max(tasks.length, 1) }))
      .sort((left, right) => right.score - left.score);
    for (const { task } of ranked.slice(0, 6)) {
      const title = singleLine(task.task || task.agentName, 18).replace(/[「」]/g, '');
      const target = tasks.length === 1 ? '这个任务' : `「${title}」`;
      if (task.status === 'waiting_for_input') candidates.push({ id: `${task.runId}:input`, runIds: [task.runId], text: `${target}需要我补充哪些信息？` });
      candidates.push({ id: `${task.runId}:progress`, runIds: [task.runId], text: `${target}目前进展如何？` });
    }
    if (tasks.length > 1) {
      const aggregate = { id: 'all:progress', runIds: tasks.map((task) => task.runId).sort(), text: '当前几个任务分别进展到哪一步了？' };
      const firstRunning = candidates.findIndex((candidate) => candidate.id.endsWith(':progress'));
      candidates.splice(firstRunning < 0 ? candidates.length : firstRunning, 0, aggregate);
    }
  }
  return { contextVersion, tasks, messages, candidates };
}
