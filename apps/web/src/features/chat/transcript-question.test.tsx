import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { AgentExecutionView } from '@worklite/contracts';
import { QuestionNote } from './transcript';

afterEach(cleanup);

describe('QuestionNote new-conversation interaction', () => {
  it('keeps the contextual Web button and submits the new-conversation action', () => {
    const onAnswer = vi.fn();
    const question = {
      id: 'question_1',
      question: '开始新对话吗？',
      action: 'new_conversation',
      options: [],
      createdAt: new Date().toISOString(),
    } as NonNullable<AgentExecutionView['pendingQuestion']>;

    render(<QuestionNote question={question} onAnswer={onAnswer} busy={false} />);

    fireEvent.click(screen.getByRole('button', { name: '新对话' }));

    expect(onAnswer).toHaveBeenCalledWith('新对话', { newConversation: true });
  });
});
