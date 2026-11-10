import type { AgentRunActivityView, AgentRunView } from '@worklite/contracts';
import type { ProjectExecutorActivity } from './project-executor.types';

// Keep only public messages and tool summaries. Reasoning and raw protocol payloads stay out.
export function appendRuntimeActivity(activities: AgentRunActivityView[], event: ProjectExecutorActivity, prefix: string): void {
  if ((event.phase === 'claude.agent_message' || (event.phase === 'codex.item_completed' && event.itemType === 'agentMessage')) && event.text?.trim()) {
    const id = `${prefix}:message:${event.itemId ?? activities.length}`;
    const previous = activities.find((activity) => activity.id === id);
    if (previous?.kind === 'message') previous.text = event.text;
    else activities.push({ id, kind: 'message', text: event.text });
    return;
  }
  const started = event.phase === 'claude.tool_started' || event.phase === 'codex.item_started';
  const completed = event.phase === 'claude.tool_completed' || event.phase === 'codex.item_completed';
  if ((!started && !completed) || !event.itemType || !event.itemId) return;
  if (event.phase.startsWith('codex.') && !['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall'].includes(event.itemType)) return;
  const id = `${prefix}:tool:${event.itemId}`;
  const previous = activities.find((activity) => activity.id === id && activity.kind === 'tool');
  const activity: AgentRunActivityView = { id, kind: 'tool', toolName: event.itemType,
    status: event.status ?? (completed ? 'completed' : 'running'),
    ...(event.summary ? { summary: event.summary } : previous?.kind === 'tool' && previous.summary ? { summary: previous.summary } : {}),
  };
  if (previous) Object.assign(previous, activity);
  else activities.push(activity);
}

export function runtimeCurrentActivity(activities: AgentRunActivityView[]): AgentRunView['currentActivity'] {
  const tools = activities.filter((activity) => activity.kind === 'tool' && activity.status === 'running');
  return tools.length ? { phase: 'tool', toolName: tools.map((activity) => activity.kind === 'tool' ? activity.summary || activity.toolName : '').join(', ') } : { phase: 'model' };
}

export function settleRuntimeActivities(activities: AgentRunActivityView[]): AgentRunActivityView[] {
  return activities.map((activity) => activity.kind === 'tool' && activity.status === 'running' ? { ...activity, status: 'interrupted' } : activity);
}
