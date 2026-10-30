import { createHash } from 'node:crypto';
import { attachmentImagesAsText } from '../../agents/chat-attachments.service';
import type { AgentTeamRunView, ChatProjectTaskView } from '@worklite/contracts';

export type FeishuAction =
  | { kind: 'answer'; runId: string; pendingInputId: string; scopeRevision: number }
  | { kind: 'agent_answer'; executionId: string; questionId: string; answer?: string; recoveryDecision?: 'adopt_command' | 'mark_failed'; newConversation?: boolean }
  | { kind: 'control'; domain: 'coder' | 'workflow' | 'conversation'; runId: string; action: 'pause' | 'resume' | 'cancel' | 'retry'; taskKey?: string }
  | { kind: 'project_task_answer'; taskId: string; questionId: string; answer?: string }
  | { kind: 'project_task_control'; taskId: string; action: 'cancel' }
  | { kind: 'recovery'; runId: string; operationKey: string; decision: 'adopt_command' | 'mark_failed' | 'replay' }
  | { kind: 'delivery' };

export type CardButton = { label: string; action: FeishuAction };
export type CardState = {
  title: string;
  status: string;
  // Secondary notation line under the status, e.g. a Coder Run's current role, model and elapsed time.
  meta?: string;
  content: string;
  replyContent?: string;
  buttons: CardButton[];
  conversation?: boolean;
  streaming?: boolean;
  details?: string;
  question?: { text: string; action: FeishuAction; replyOnly?: boolean };
  imageKey?: string;
};
export type FeishuCard = {
  schema: '2.0';
  config: { update_multi: true; streaming_mode: boolean; streaming_config: Record<string, unknown>; summary: { content: string } };
  header?: Record<string, unknown>;
  body: { elements: Record<string, unknown>[] };
};
export type CardUpdate = {
  kind: 'settings' | 'card' | 'element' | 'content';
  elementId?: string;
  data: string;
  sequence: number;
  uuid: string;
  card: FeishuCard;
  streamingStartedAt: number | null;
};
export type CardTransport = {
  cardId: string;
  sequence: number;
  card: FeishuCard;
  streamingStartedAt: number | null;
  pending?: CardUpdate;
};
export type SavedCard = {
  card: FeishuCard;
  actions: Record<string, FeishuAction>;
  content: string;
  questionText?: string;
  replyAction?: FeishuAction;
  transport?: CardTransport;
};

const text = (content: string) => ({ tag: 'plain_text', content });
export function renderCard(submissionId: string, state: CardState): SavedCard {
  const actions: Record<string, FeishuAction> = {};
  const button = ({ label, action }: CardButton, form = false) => {
    const key = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    actions[key] = action;
    return {
      tag: 'button', text: text(label), type: 'default',
      ...(form ? { name: `submit_${key}`, form_action_type: 'submit' } : {}),
      behaviors: [{ type: 'callback', value: { submissionId, actionKey: key } }],
    };
  };
  const elements: Record<string, unknown>[] = [];
  if (state.status) elements.push({
    tag: 'div', element_id: 'status', text: { ...text(state.status), text_size: 'notation', text_color: 'default' },
    ...(['正在思考…', '正在回复…', '正在处理…', '正在执行', '正在启动'].includes(state.status)
      ? { icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } } : {}),
  });
  if (state.meta) elements.push({ tag: 'div', element_id: 'meta', text: { ...text(state.meta), text_size: 'notation', text_color: 'grey' } });
  // Card Markdown images need a Feishu img_key, so WorkLite attachment images become a note pointing to Web.
  if (state.content || state.conversation) elements.push({ tag: 'markdown', element_id: 'reply', content: attachmentImagesAsText(state.content) || ' ' });
  if (state.details) elements.push({
    tag: 'collapsible_panel', element_id: 'details', expanded: false,
    header: { title: text('执行详情'), icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' } },
    elements: [{ tag: 'markdown', element_id: 'task_details', content: attachmentImagesAsText(state.details) }],
  });
  if (state.imageKey) elements.push({ tag: 'img', element_id: 'task_qr', img_key: state.imageKey, alt: text('扫码完成当前任务') });
  if (state.question) {
    elements.push({ tag: 'markdown', element_id: 'question', content: attachmentImagesAsText(state.question.text) });
    if (!state.question.replyOnly) elements.push({ tag: 'form', element_id: 'answer_form', name: 'task_answer', elements: [
      { tag: 'input', name: 'answer', input_type: 'multiline_text', label: text('回答'), placeholder: text('补充当前任务需要的信息'), required: true },
      button({ label: '提交回答', action: state.question.action }, true),
    ] });
  }
  // JSON 2.0 places interactive components in columns rather than a legacy action container.
  for (let index = 0; index < state.buttons.length; index += 3) {
    elements.push({ tag: 'column_set', element_id: `actions_${index}`, flex_mode: 'flow', columns: state.buttons.slice(index, index + 3).map((item) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button(item)] })) });
  }
  return { card: { schema: '2.0', config: {
    update_multi: true, streaming_mode: state.streaming === true,
    streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: 'fast' },
    summary: { content: state.status || state.content.replace(/\s+/g, ' ').slice(0, 100) },
  }, ...(!state.conversation ? { header: { title: text(state.title), template: 'grey' } } : {}), body: { elements } }, actions, content: state.replyContent ?? state.content, ...(state.question ? { replyAction: state.question.action, questionText: state.question.text } : {}) };
}

export const statusText: Record<string, string> = {
  queued: '已排队', collecting: '等待补充信息', starting: '正在启动', started: '已启动', running: '正在执行', waiting_for_input: '等待你的回答',
  waiting_for_recovery: '等待确认执行结果',
  paused: '已暂停', succeeded: '已完成', completed: '已完成', failed: '执行失败', cancelled: '已取消', timed_out: '执行超时',
};

export const stageText: Record<string, string> = {
  starting: '正在启动', working: '正在执行', responding: '正在回复', waiting: '等待输入',
  succeeded: '已完成', failed: '执行失败', cancelled: '已取消',
};

const TASK_ACTIVITY_LINES = 5;
const TASK_RESULT_LIMIT = 3000;

// One card per project task, mirroring the Web task panel: executor, model, stage, latest
// progress, an item-by-item recent-activity list, the task's own question form and cancel control.
export function renderTaskCard(submissionId: string, task: ChatProjectTaskView): SavedCard {
  const actions: Record<string, FeishuAction> = {};
  const button = (label: string, action: FeishuAction, form = false) => {
    const key = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    actions[key] = action;
    return {
      tag: 'button', text: text(label), type: 'default',
      ...(form ? { name: `submit_${key}`, form_action_type: 'submit' } : {}),
      behaviors: [{ type: 'callback', value: { submissionId, actionKey: key } }],
    };
  };
  const executorName = task.executor === 'codex' ? 'Codex' : task.executor === 'claude' ? 'Claude Code' : '项目任务';
  const elements: Record<string, unknown>[] = [];
  const progressLine = (task.progressText ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
  const status = [statusText[task.status] ?? task.status, stageText[task.stage] ?? task.stage, progressLine].filter(Boolean).join(' · ');
  elements.push({
    tag: 'div', element_id: 'status', text: { ...text(status), text_size: 'notation', text_color: 'default' },
    ...(['running', 'waiting_for_input'].includes(task.status) ? { icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } } : {}),
  });
  const goal = task.goal.length > 500 ? `${task.goal.slice(0, 497)}…` : task.goal;
  elements.push({ tag: 'markdown', element_id: 'goal', content: goal });
  const recent = task.activities.slice(-TASK_ACTIVITY_LINES);
  if (recent.length) {
    const lines = recent.map((activity) => {
      const summary = typeof activity.summary === 'string' && activity.summary.trim() ? activity.summary
        : typeof activity.text === 'string' && activity.text.trim() ? activity.text.trim().split(/\r?\n/, 1)[0]
          : typeof activity.toolName === 'string' ? activity.toolName
            : '';
      const phase = typeof activity.phase === 'string' ? activity.phase : '';
      return `- ${[phase, summary].filter(Boolean).join(' · ')}`.slice(0, 200);
    });
    elements.push({ tag: 'markdown', element_id: 'activity', content: `${lines.join('\n')}\n\n共 ${task.activityCount} 条活动记录` });
  }
  const outcome = attachmentImagesAsText([task.error, task.result].filter(Boolean).join('\n\n'));
  if (outcome) elements.push({ tag: 'markdown', element_id: 'result', content: outcome.length > TASK_RESULT_LIMIT ? `${outcome.slice(0, TASK_RESULT_LIMIT)}…\n\n完整结果见 Web 任务卡片。` : outcome });
  let replyAction: FeishuAction | undefined;
  let questionText: string | undefined;
  const buttons: ReturnType<typeof button>[] = [];
  if (task.status === 'waiting_for_input' && task.pendingQuestion) {
    const action: FeishuAction = { kind: 'project_task_answer', taskId: task.id, questionId: task.pendingQuestion.id };
    replyAction = action;
    questionText = task.pendingQuestion.question;
    elements.push({ tag: 'markdown', element_id: 'question', content: attachmentImagesAsText(task.pendingQuestion.question) });
    elements.push({ tag: 'form', element_id: 'answer_form', name: 'task_answer', elements: [
      { tag: 'input', name: 'answer', input_type: 'multiline_text', label: text('回答'), placeholder: text('补充当前任务需要的信息'), required: true },
      button('提交回答', action, true),
    ] });
  }
  if (task.status === 'running' || task.status === 'waiting_for_input') {
    buttons.push(button('取消任务', { kind: 'project_task_control', taskId: task.id, action: 'cancel' }));
  }
  for (let index = 0; index < buttons.length; index += 3) {
    elements.push({ tag: 'column_set', element_id: `actions_${index}`, flex_mode: 'flow', columns: buttons.slice(index, index + 3).map((item) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [item] })) });
  }
  return {
    card: {
      schema: '2.0', config: {
        update_multi: true, streaming_mode: false,
        streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: 'fast' },
        summary: { content: status },
      },
      header: { title: text(`${executorName} · ${task.model || '默认模型'}`), template: 'grey' },
      body: { elements },
    },
    actions, content: outcome || goal,
    ...(replyAction ? { replyAction, questionText } : {}),
  };
}

const TEAM_ROLE_NAMES: Record<string, string> = {
  planner: 'Planner', 'test-designer': 'Test Designer', developer: 'Developer', 'test-author': 'Test Author',
  'test-runner': 'Test Runner', reviewer: 'Reviewer', 'worktree-manager': 'Worktree Manager', 'executor-manager': 'Executor Manager',
};

export function teamRoleName(task: { role: string; roleName: string | null }): string {
  return task.roleName ?? TEAM_ROLE_NAMES[task.role] ?? task.role;
}

export function formatElapsed(fromIso: string | null, toMs: number): string | null {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(toMs)) return null;
  const minutes = Math.max(0, Math.floor((toMs - from) / 60_000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(minutes / (24 * 60))} 天 ${Math.floor((minutes % (24 * 60)) / 60)} 小时`;
}

// The Coder card's one-line summary, matching the Web card: current role (or the in-flight count
// when Developer lanes run in parallel), its model, the role's elapsed time and the Run total.
export function teamRunMeta(run: AgentTeamRunView, now = Date.now()): string {
  const settled = ['succeeded', 'failed', 'cancelled'].includes(run.status);
  const runEnd = settled ? Date.parse(run.finishedAt ?? run.updatedAt) : now;
  const parts: string[] = [];
  const current = run.current;
  if (current && !settled) {
    let role = teamRoleName(current);
    if (current.activeCount > 1) role = current.activeRoleCount > 1 ? `${current.activeCount} 个角色进行中` : `${role} ×${current.activeCount}`;
    parts.push(role);
    if (current.model) parts.push(current.model);
    const roleElapsed = formatElapsed(current.startedAt, now);
    if (roleElapsed && current.activeCount === 1) parts.push(`本角色 ${roleElapsed}`);
  }
  if (run.progress?.totalAssignments && !settled) parts.push(`开发任务 ${run.progress.completedAssignments}/${run.progress.totalAssignments}`);
  const total = formatElapsed(run.createdAt, runEnd);
  if (total) parts.push(`总耗时 ${total}`);
  return parts.join(' · ');
}
