import { describe, expect, it } from 'vitest';
import { withBudgetReminder, type GatewayAgentMessage } from './index';

const history = (count: number): GatewayAgentMessage[] => Array.from({ length: count }, (_, index) => (
  index === 0
    ? { role: 'user', content: 'task' }
    : { role: 'assistant', content: [{ type: 'text', text: `step ${index}` }] }
));

describe('withBudgetReminder', () => {
  it('leaves messages unchanged before the reminder round or without a valid reminder round', () => {
    const messages = history(3);
    expect(withBudgetReminder(messages, 4, 30, 18, undefined)).toEqual({ messages, reminderIndex: undefined });
    expect(withBudgetReminder(messages, 20, 30, undefined, undefined).messages).toBe(messages);
    expect(withBudgetReminder(messages, 30, 30, 30, undefined).messages).toBe(messages);
  });

  it('appends the reminder once and keeps it at the same position so the request prefix stays stable', () => {
    const first = withBudgetReminder(history(5), 18, 30, 18, undefined);
    expect(first.reminderIndex).toBe(5);
    expect(first.messages).toHaveLength(6);
    expect(first.messages[5]).toEqual({ role: 'user', content: expect.stringContaining('at most 12 tool rounds remain') });

    const later = withBudgetReminder(history(7), 19, 30, 18, first.reminderIndex);
    expect(later.reminderIndex).toBe(5);
    expect(later.messages.slice(0, 6)).toEqual(first.messages);
    expect(later.messages.filter((message) => message.role === 'user')).toHaveLength(2);
  });
});
