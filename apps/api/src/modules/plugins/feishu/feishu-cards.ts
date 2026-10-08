import { createHash } from 'node:crypto';

export type FeishuAction =
  | { kind: 'intake'; teamId: string; intakeSubmissionId: string; field: 'goal' | 'projectDirectory' | 'mode'; answer?: string }
  | { kind: 'answer'; runId: string; pendingInputId: string; scopeRevision: number }
  | { kind: 'agent_answer'; executionId: string; questionId: string; answer?: string; recoveryDecision?: 'adopt_command' | 'mark_failed'; newConversation?: boolean }
  | { kind: 'control'; domain: 'team' | 'workflow' | 'conversation'; runId: string; action: 'pause' | 'resume' | 'cancel' | 'retry'; taskKey?: string }
  | { kind: 'recovery'; runId: string; operationKey: string; decision: 'adopt_command' | 'mark_failed' | 'replay' }
  | { kind: 'delivery' };

export type CardButton = { label: string; action: FeishuAction };
export type CardState = {
  title: string;
  status: string;
  content: string;
  replyContent?: string;
  buttons: CardButton[];
  conversation?: boolean;
  streaming?: boolean;
  details?: string;
  question?: { text: string; action: FeishuAction; commands?: boolean; replyOnly?: boolean };
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
  if (state.content || state.conversation) elements.push({ tag: 'markdown', element_id: 'reply', content: state.content || ' ' });
  if (state.details) elements.push({
    tag: 'collapsible_panel', element_id: 'details', expanded: false,
    header: { title: text('执行详情'), icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' } },
    elements: [{ tag: 'markdown', element_id: 'task_details', content: state.details }],
  });
  if (state.imageKey) elements.push({ tag: 'img', element_id: 'task_qr', img_key: state.imageKey, alt: text('扫码完成当前任务') });
  if (state.question) {
    elements.push({ tag: 'markdown', element_id: 'question', content: state.question.text });
    if (!state.question.replyOnly) elements.push({ tag: 'form', element_id: 'answer_form', name: 'task_answer', elements: [
      { tag: 'input', name: 'answer', input_type: 'multiline_text', label: text('回答'), placeholder: text('补充当前任务需要的信息'), required: true },
      ...(state.question.commands ? [{ tag: 'input', name: 'commands', input_type: 'multiline_text', label: text('授权执行的完整命令（可选，每行一条）'), placeholder: text('只有在此明确提交的命令才会获得授权') }] : []),
      button({ label: state.question.commands ? '提交回答与命令授权' : '提交回答', action: state.question.action }, true),
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
