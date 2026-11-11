import type { AgentExecutionView, AgentToolCallView } from './index';

export type ChatSuggestion = { id: string; text: string; runIds: string[] };
export type ChatSuggestionResponse = {
  contextVersion: string;
  suggestion: ChatSuggestion | null;
  source: 'rules' | 'jev';
};

type SuggestionTask = Pick<NonNullable<AgentToolCallView['agentInvocation']>, 'runId' | 'agentId' | 'agentName' | 'task'> & {
  status?: NonNullable<AgentToolCallView['agentInvocation']>['status'] | 'waiting_for_recovery';
  result?: string;
};

const singleLine = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit);

/** Shared by the UI and API: a poll or tool-phase change alone is not a new recommendation. */
export function chatSuggestionContext(execution: AgentExecutionView | null) {
  const latest = new Map<string, SuggestionTask>();
  for (const call of execution?.toolCalls ?? []) {
    const project = call.projectTask;
    const task: SuggestionTask | undefined = project ? {
      runId: project.id, agentId: '', agentName: '', task: project.goal,
      status: project.status === 'succeeded' ? 'completed' : project.status,
      result: singleLine(project.result || project.error || '', 400),
    } : call.agentInvocation;
    if (task?.status) {
      // A continued run belongs at its most recent appearance, without duplicating it.
      latest.delete(task.runId);
      latest.set(task.runId, task);
    }
  }
  const tasks = [...latest.values()].map(({ runId, agentId, agentName, task, status, result }) => ({
    runId, agentId, agentName, task: singleLine(task, 240), status, ...(result ? { result } : {}),
  }));
  // The composer also accepts queued follow-ups while Chat is replying. Keep that
  // turn's streaming assistant text out of the decision context until it settles.
  const history = execution?.messages ?? [];
  let lastUserIndex = history.length - 1;
  while (lastUserIndex >= 0 && history[lastUserIndex]?.role !== 'user') lastUserIndex--;
  const stableMessages = execution?.status === 'running' ? history.slice(0, lastUserIndex + 1) : history;
  const messages = stableMessages.filter((message) => message.kind !== 'summary_divider' && message.content.trim())
    .slice(-4).map(({ role, content }) => ({ role, content: singleLine(content, 400) }));
  const signature = JSON.stringify([execution?.id ?? null, execution?.status === 'running' ? 'running' : 'settled', Boolean(execution?.pendingQuestion), tasks, messages]);
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
  if (!execution?.pendingQuestion) {
    const recentUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const ranked = tasks.map((task, index) => ({ task, score: (task.status === 'waiting_for_input' ? 100 : 0)
      + ((task.agentName && recentUser.includes(task.agentName)) || (task.task && recentUser.includes(task.task)) ? 20 : 0) + index / Math.max(tasks.length, 1) }))
      .sort((left, right) => right.score - left.score);
    for (const { task } of ranked.slice(0, 6)) {
      const title = singleLine(task.task || task.agentName, 18).replace(/[「」]/g, '');
      const target = tasks.length === 1 ? '这个任务' : `「${title}」`;
      const add = (kind: string, text: string) => candidates.push({ id: `${task.runId}:${kind}`, runIds: [task.runId], text });
      if (task.status === 'completed') {
        add('result', `帮我检查${target}的结果，还有哪些需要验证或跟进？`);
        add('next', `基于${target}的结果，接下来有哪些可选的下一步？`);
      } else if (task.status === 'failed') {
        add('failure', `${target}失败的原因是什么，接下来可以怎么处理？`);
      } else if (task.status === 'cancelled') {
        add('cancelled', `${target}取消前完成了哪些工作，还有哪些未完成？`);
      } else if (task.status === 'paused' || task.status === 'waiting_for_recovery') {
        add('recovery', `${target}需要确认哪些条件才能继续？`);
      } else {
        if (task.status === 'waiting_for_input') add('input', `${target}需要我补充哪些信息？`);
        add('progress', `${target}目前进展如何？`);
      }
    }
    if (tasks.length > 1) {
      const allRunning = tasks.every((task) => task.status === 'running' || task.status === 'waiting_for_input');
      const aggregate = { id: allRunning ? 'all:progress' : 'all:overview', runIds: tasks.map((task) => task.runId).sort(),
        text: allRunning ? '当前几个任务分别进展到哪一步了？' : '帮我汇总这些任务的结果和进展，并列出接下来需要跟进的事项。' };
      const firstNonInput = candidates.findIndex((candidate) => !candidate.id.endsWith(':input'));
      candidates.splice(firstNonInput < 0 ? candidates.length : firstNonInput, 0, aggregate);
      if (!allRunning) candidates.push({ id: 'all:next', runIds: aggregate.runIds, text: '结合这些任务的结果，接下来优先做哪件事比较合适？' });
    }
    if (!tasks.length) {
      candidates.push({ id: execution ? 'conversation:next' : 'new:start', runIds: [], text: execution
        ? execution.status === 'failed' ? '刚才的问题是什么原因，接下来可以怎么处理？' : '帮我梳理刚才的结论，以及接下来需要确认或跟进的事项。'
        : '帮我梳理目标，并拆成可以执行的任务。' });
    }
  }
  return { contextVersion, tasks, messages, candidates };
}
