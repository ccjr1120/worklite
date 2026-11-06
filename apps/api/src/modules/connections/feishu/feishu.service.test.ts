import { describe, expect, it } from 'vitest';
import { FeishuService } from './feishu.service';
import type { SavedCard } from './feishu-cards';

describe('Feishu new-conversation interaction', () => {
  it('renders the pending intent as a native card button with a bound action', async () => {
    const delivered: SavedCard[] = [];
    const db = {
      update: () => {
        const query = { set: () => query, where: () => Promise.resolve(undefined) };
        return query;
      },
    };
    const executions = {
      get: async () => ({
        id: 'aex_1',
        status: 'waiting_for_input',
        phase: 'model',
        error: null,
        messages: [],
        toolCalls: [],
        pendingQuestion: {
          id: 'question_1',
          question: '是否开始新对话？',
          action: 'new_conversation',
          options: [],
          createdAt: new Date().toISOString(),
        },
      }),
      events: async () => [],
    };
    const service = new FeishuService(db as never, {} as never, {} as never, executions as never, {} as never, {} as never, {} as never, {} as never);
    (service as unknown as { deliverCard: (submission: unknown, slotKey: string, saved: SavedCard, renewStream: boolean) => Promise<void> }).deliverCard = async (_submission, _slotKey, saved) => { delivered.push(saved); };
    const submission = {
      id: 'sub_1',
      chatId: 'feishu:chat_1',
      target: { kind: 'conversation' },
      message: '新对话',
      error: null,
      reference: { kind: 'conversation', executionId: 'aex_1', afterMessageId: null, afterSequence: 0 },
      deliveryFingerprint: null,
      renderedCard: null,
      renderedTaskCards: null,
    };

    await (service as unknown as { deliver: (value: typeof submission) => Promise<void> }).deliver(submission);

    expect(delivered).toHaveLength(1);
    expect(JSON.stringify(delivered[0].card)).toContain('"tag":"button"');
    expect(Object.values(delivered[0].actions)).toContainEqual({
      kind: 'agent_answer', executionId: 'aex_1', questionId: 'question_1', answer: '开启新对话', newConversation: true,
    });
  });
});
