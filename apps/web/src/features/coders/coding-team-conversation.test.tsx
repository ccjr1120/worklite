import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodingTeamConversation } from './coding-team-conversation';

const state = vi.hoisted(() => ({ groupId: 'group_1' as string | null, messages: [] as Array<Record<string, unknown>> }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/chat">{children}</a> }));
vi.mock('@/api/queries', () => ({
  agentTeamGroupQueryKey: (id: string) => ['group', id],
  agentTeamRunQueryKey: (id: string) => ['run', id],
  useAgentTeamRunQuery: () => ({ data: { groupId: state.groupId } }),
  useAgentTeamGroupQuery: () => ({ data: { messages: state.messages, runs: [{ id: 'run_1', tasks: [] }] } }),
}));
vi.mock('@/components/ai/streaming-markdown', () => ({ StreamingMarkdown: ({ content }: { content: string }) => <div>{content}</div> }));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() { MockEventSource.instances.push(this); }
  close() {}
}
vi.stubGlobal('EventSource', MockEventSource);
afterEach(() => { cleanup(); state.groupId = 'group_1'; state.messages = []; MockEventSource.instances = []; });

function showConversation(client = new QueryClient()) {
  render(<QueryClientProvider client={client}><CodingTeamConversation runId="run_1" /></QueryClientProvider>);
}

describe('Coding Team conversation', () => {
  it('does not fall back to legacy run details when no transcript messages exist', () => {
    state.messages = [{ id: 'other', runId: 'run_2' }];
    showConversation();
    expect(screen.getByLabelText('团队对话')).toBeEmptyDOMElement();
  });

  it('does not open legacy Run details for a historical Run without a group transcript', () => {
    state.groupId = null;
    showConversation();
    expect(screen.getByLabelText('团队对话')).toBeEmptyDOMElement();
  });

  it('shows persisted sender and recipient and refetches after reconnecting', () => {
    state.messages = [{ id: 'message_1', runId: 'run_1', sender: 'role', senderRole: 'planner', recipientRole: 'router', body: '完成' }];
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    showConversation(client);
    expect(screen.getByText('planner')).toBeVisible();
    expect(screen.getByText('@router')).toBeVisible();
    expect(screen.getByText('完成')).toBeVisible();
    for (const source of MockEventSource.instances) source.onopen?.();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['group', 'group_1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['run', 'run_1'] });
  });
});
