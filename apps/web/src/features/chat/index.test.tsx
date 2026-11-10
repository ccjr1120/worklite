import type { ComponentProps } from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatSuggestionContext, type AgentExecutionView, type AgentToolCallView, type AgentView, type ChatConversationSummary, type ChatSuggestionResponse } from '@worklite/contracts';
import '@/i18n/config';
import { api } from '@/api/client';
import { LocaleProvider } from '@/components/locale-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { chatConversationsQueryKey } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { ChatWorkspace } from './index';

const { navigate, search } = vi.hoisted(() => ({ navigate: vi.fn(), search: {} }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) => select({ location: { search } }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ applyAppearancePreference: vi.fn() }) }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: () => null }));
vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationContent: (props: ComponentProps<'div'>) => <div {...props} />,
}));

const earlier: ChatConversationSummary = { id: 'earlier', executionId: null, title: '较早的会话', channel: 'web', channelConversationId: null, status: 'completed', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T01:00:00Z' };
const latest: ChatConversationSummary = { ...earlier, id: 'latest', title: '最近的会话', status: 'failed', updatedAt: '2026-11-02T01:00:00Z' };

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  queryClient.clear();
  vi.spyOn(api, 'agent').mockResolvedValue({ providerId: 'provider', model: 'model' } as AgentView);
  vi.spyOn(api, 'agents').mockResolvedValue([]);
  vi.spyOn(api, 'modelProviders').mockResolvedValue([]);
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'chatChannels').mockResolvedValue([]);
  vi.spyOn(api, 'chatConversations').mockResolvedValue({ items: [earlier, latest], nextCursor: null });
  vi.spyOn(api, 'chatConversation').mockImplementation(async (id) => ({ conversation: id === earlier.id ? earlier : latest, execution: null, submissions: [], pendingReceipts: [], channelDelivery: 'web' }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});

let suggestionConversation = 0;
class SuggestionEvents {
  static latest: SuggestionEvents;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { SuggestionEvents.latest = this; }
  close() {}
}

async function mountSuggestedChat(deferred?: Promise<ChatSuggestionResponse>) {
  const id = `suggestion-${++suggestionConversation}`;
  const execution: AgentExecutionView = {
    id, agentId: 'agt_system_helper_chat', status: 'completed', conversationStatus: 'running', phase: 'model', errorCode: null,
    executionAuthorization: null, messages: [], pendingQuestion: null, plan: [], error: null, contextDropped: 0,
    createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    toolCalls: [{ id: 'dispatch', status: 'completed', createdAt: '2026-11-10T00:00:00Z', finishedAt: '2026-11-10T00:00:00Z', arguments: [], output: '', result: null,
      workingDirectory: '', skillId: null, skillName: null, scriptPath: null, mcpServerId: null, mcpToolName: 'run_agent', exitCode: 0, commandExecutionId: null,
      agentInvocation: { agentId: 'coder', agentName: 'coder', runId: 'run', task: '调查输入框', status: 'running', phase: 'model' },
    } as AgentToolCallView],
  };
  const summary = { ...earlier, id, executionId: id, title: '推荐问题测试', status: 'running' as const };
  vi.stubGlobal('EventSource', SuggestionEvents);
  vi.mocked(api.chatConversations).mockResolvedValue({ items: [summary, latest], nextCursor: null });
  vi.mocked(api.chatConversation).mockImplementation(async (selected) => ({ conversation: selected === id ? summary : latest,
    execution: selected === id ? execution : null, submissions: [], pendingReceipts: [], channelDelivery: 'web' }));
  const suggest = vi.spyOn(api, 'chatSuggestions').mockImplementation(async (_id, contextVersion) => deferred ?? ({ contextVersion, suggestion: chatSuggestionContext(execution).candidates[0]!, source: 'jev' }));
  const dispatch = vi.spyOn(api, 'dispatchChat');
  window.localStorage.setItem('worklite.chat.selected', id);
  const sidebar = mount();
  const input = await screen.findByRole('combobox', { name: '向 Chat 发送消息' }) as HTMLTextAreaElement;
  await waitFor(() => expect(suggest).toHaveBeenCalled());
  let sequence = 0;
  function snapshot(next: AgentExecutionView) {
    act(() => SuggestionEvents.latest.onmessage?.({ data: JSON.stringify({ executionId: id, sequence: ++sequence, createdAt: '2026-11-10T00:00:01Z', data: { kind: 'snapshot', execution: { ...next, updatedAt: '2026-11-10T00:00:01Z' } } }) }));
  }
  return { input, execution, sidebar, suggest, dispatch, snapshot };
}

describe('Chat placeholder suggestions', () => {
  it.each(['codex', 'claude'] as const)('works for %s Chat without a native provider configuration', async (kind) => {
    vi.mocked(api.agent).mockResolvedValue({ runtime: { kind }, providerId: null, model: null } as unknown as AgentView);
    const { input } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
  });
  it('fills an editable draft on Tab without sending and preserves normal Tab afterwards', async () => {
    const { input, dispatch } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    input.focus();
    const tab = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(input).toHaveValue('这个任务目前进展如何？');
    expect(input).toHaveFocus();
    expect(dispatch).not.toHaveBeenCalled();
    const nextTab = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, nextTab);
    expect(nextTab.defaultPrevented).toBe(false);
    fireEvent.change(input, { target: { value: '补充：只看当前进度' } });
    expect(input).toHaveValue('补充：只看当前进度');
    fireEvent.change(input, { target: { value: '' } });
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
  });
  it('ignores on Escape across equal snapshots and returning to the same conversation', async () => {
    const { input, sidebar, execution, snapshot } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    fireEvent.keyDown(input, { key: 'Escape' });
    snapshot(execution);
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    fireEvent.click(within(sidebar).getByRole('button', { name: '最近的会话 失败' }));
    fireEvent.click(within(sidebar).getByRole('button', { name: /推荐问题测试/ }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toBeVisible());
    expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
  });
  it('sends the accepted draft only after the user presses Enter', async () => {
    const { input, dispatch, execution } = await mountSuggestedChat();
    dispatch.mockResolvedValue({ reference: { kind: 'conversation', executionId: execution.id } } as never);
    vi.spyOn(api, 'agentExecution').mockResolvedValue(execution);
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(dispatch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ message: '这个任务目前进展如何？', target: { kind: 'conversation' }, executionId: execution.id });
    await waitFor(() => expect(input).toHaveValue(''));
  });
  it('keeps the suggestion available while Chat replies and does not rerank each text delta', async () => {
    const { input, execution, snapshot, suggest } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    snapshot({ ...execution, status: 'running', messages: [
      { id: 'u', role: 'user', content: '看看任务', createdAt: '' },
      { id: 'stream', role: 'assistant', content: '正在', createdAt: '' },
    ] });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    act(() => SuggestionEvents.latest.onmessage?.({ data: JSON.stringify({ executionId: execution.id, sequence: 2, createdAt: '', data: { kind: 'message_delta', messageId: 'stream', delta: '检查状态' } }) }));
    expect(suggest).toHaveBeenCalledTimes(2);
    expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？');
  });
  it('does not intercept Shift+Tab, IME composition, or Tab without a suggestion', async () => {
    const { input } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    for (const init of [{ key: 'Tab', shiftKey: true }, { key: 'Tab', isComposing: true }, { key: 'Tab', keyCode: 229 }]) {
      const event = createEvent.keyDown(input, init);
      fireEvent(input, event);
      expect(event.defaultPrevented).toBe(false);
      expect(input).toHaveValue('');
    }
    fireEvent.compositionStart(input);
    const composing = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, composing);
    expect(composing.defaultPrevented).toBe(false);
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: '自己的问题' } });
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    const typing = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, typing);
    expect(typing.defaultPrevented).toBe(false);
  });
  it('suspends for slash/mention menus, the switcher and Chat clarification', async () => {
    const { input, execution, snapshot } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    for (const value of ['/', '@coder']) {
      fireEvent.change(input, { target: { value } });
      expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    }
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    fireEvent.keyDown(input, { key: 'Escape' });
    snapshot({ ...execution, status: 'waiting_for_input', pendingQuestion: { id: 'q', question: '确认输入方式？', options: [], createdAt: '' } });
    expect(input).toHaveAttribute('placeholder', '回答澄清问题...');
  });
  it('clears as soon as the task settles, even though its original dispatch is completed', async () => {
    const { input, execution, snapshot } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    snapshot({ ...execution, conversationStatus: 'completed', toolCalls: execution.toolCalls.map((call) => ({ ...call, agentInvocation: { ...call.agentInvocation!, status: 'completed' } })) });
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    const tab = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, tab);
    expect(tab.defaultPrevented).toBe(false);
  });
  it('suspends after choosing an Agent even when the mention text has been cleared', async () => {
    vi.mocked(api.agents).mockResolvedValue([{ id: 'coder', name: 'coder', kind: 'custom' } as AgentView]);
    const { input } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    fireEvent.change(input, { target: { value: '@coder' } });
    await screen.findByRole('option', { name: 'coder' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('');
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    const tab = createEvent.keyDown(input, { key: 'Tab' });
    fireEvent(input, tab);
    expect(tab.defaultPrevented).toBe(false);
  });
  it('does not apply a decision that returns after switching conversations', async () => {
    let resolve!: (result: ChatSuggestionResponse) => void;
    const deferred = new Promise<ChatSuggestionResponse>((done) => { resolve = done; });
    const { execution, sidebar } = await mountSuggestedChat(deferred);
    fireEvent.click(within(sidebar).getByRole('button', { name: '最近的会话 失败' }));
    const context = chatSuggestionContext(execution);
    await act(async () => resolve({ contextVersion: context.contextVersion, suggestion: context.candidates[0]!, source: 'jev' }));
    const input = await screen.findByRole('combobox', { name: '向 Chat 发送消息' });
    expect(input).toHaveValue('');
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
  });
  it('drops a late decision when typing starts or the conversation changes', async () => {
    let resolve!: (result: ChatSuggestionResponse) => void;
    const deferred = new Promise<ChatSuggestionResponse>((done) => { resolve = done; });
    const { input, execution, sidebar } = await mountSuggestedChat(deferred);
    fireEvent.change(input, { target: { value: '我自己的问题' } });
    const context = chatSuggestionContext(execution);
    await act(async () => resolve({ contextVersion: context.contextVersion, suggestion: context.candidates[0]!, source: 'jev' }));
    expect(input).toHaveValue('我自己的问题');
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
    fireEvent.click(within(sidebar).getByRole('button', { name: '最近的会话 失败' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toHaveValue(''));
    expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
  });
  it('falls back on request failure and respects a successful Jev decision to show nothing', async () => {
    const { input, suggest, execution, snapshot } = await mountSuggestedChat();
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    suggest.mockRejectedValue(new Error('offline'));
    snapshot({ ...execution, messages: [{ id: 'u', role: 'user', content: '看一下任务', createdAt: '' }] });
    await waitFor(() => expect(input).toHaveAttribute('placeholder', '这个任务目前进展如何？'));
    expect(suggest).toHaveBeenCalledTimes(2);
    suggest.mockImplementation(async (_id, contextVersion) => ({ contextVersion, suggestion: null, source: 'jev' }));
    snapshot({ ...execution, messages: [{ id: 'u2', role: 'user', content: '已了解进度', createdAt: '' }] });
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(3));
    expect(input).not.toHaveAttribute('placeholder', '这个任务目前进展如何？');
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  navigate.mockClear();
});

function mount() {
  render(<QueryClientProvider client={queryClient}><LocaleProvider><TooltipProvider><ChatWorkspace /></TooltipProvider></LocaleProvider></QueryClientProvider>);
  return screen.getByRole('complementary', { name: '会话' });
}

describe('Chat conversation sidebar', () => {
  it('shows titles and statuses in update order and preserves drafts when switching', async () => {
    window.localStorage.setItem('worklite.chat.selected', earlier.id);
    const sidebar = mount();
    await within(sidebar).findByRole('button', { name: '最近的会话 失败' });
    expect(within(sidebar).getAllByRole('button').map((button) => button.textContent)).toEqual(['新对话', '最近的会话', '较早的会话']);
    expect(within(sidebar).queryByText('已完成')).not.toBeInTheDocument();
    expect(within(sidebar).queryByText('Web')).not.toBeInTheDocument();
    expect(sidebar.querySelector('time')).toBeNull();
    expect(within(sidebar).queryByRole('heading', { name: /今天|更早/ })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: '较早的会话' })).toHaveAttribute('aria-current', 'true');
    const composer = await screen.findByRole('combobox', { name: '向 Chat 发送消息' });
    fireEvent.change(composer, { target: { value: '保留这份草稿' } });
    fireEvent.click(within(sidebar).getByRole('button', { name: '较早的会话' }));
    expect(screen.getByRole('region', { name: 'Chat' })).toHaveTextContent('较早的会话');
    expect(composer).toHaveValue('保留这份草稿');
    fireEvent.click(within(sidebar).getByRole('button', { name: '最近的会话 失败' }));
    await waitFor(() => expect(api.chatConversation).toHaveBeenLastCalledWith(latest.id));
    expect(within(sidebar).getByRole('button', { name: '最近的会话 失败' })).toHaveAttribute('aria-current', 'true');
    expect(window.localStorage.getItem('worklite.chat.selected')).toBe(latest.id);
    fireEvent.click(within(sidebar).getByRole('button', { name: '较早的会话' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toHaveValue('保留这份草稿'));
    expect(navigate).toHaveBeenLastCalledWith({ to: '/chat', search: { view: 'conversation', conversation: earlier.id } });
  });

  it('keeps /new and the composer-anchored /resume switcher in sync with the sidebar', async () => {
    window.localStorage.setItem('worklite.chat.selected', earlier.id);
    const sidebar = mount();
    const composer = await screen.findByRole('combobox', { name: '向 Chat 发送消息' });
    fireEvent.change(composer, { target: { value: '/new' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(within(sidebar).getByRole('button', { name: '新对话' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toHaveValue('');
    expect(window.localStorage.getItem('worklite.chat.selected')).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith({ to: '/chat', search: { view: 'conversation', conversation: undefined } });
    await waitFor(() => expect(composer).toHaveFocus());

    fireEvent.change(composer, { target: { value: '/resume' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    const switcher = await screen.findByRole('dialog', { name: '会话' });
    expect(switcher.closest('[data-side]')).toHaveAttribute('data-side', 'top');
    await within(switcher).findByRole('button', { name: /最近的会话/ });
    expect(within(switcher).queryByRole('button', { name: '新对话' })).not.toBeInTheDocument();
    expect(within(switcher).getByText('已完成')).toBeVisible();
    expect(switcher).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(within(switcher).getByRole('button', { name: /最近的会话/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(within(switcher).getByRole('button', { name: /较早的会话/ })).toHaveFocus();
    const headingIds = Array.from(document.querySelectorAll('h3[id]')).map((heading) => heading.id);
    expect(new Set(headingIds).size).toBe(headingIds.length);

    fireEvent.click(within(switcher).getByRole('button', { name: /最近的会话/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '会话' })).not.toBeInTheDocument());
    expect(within(sidebar).getByRole('button', { name: '最近的会话 失败' })).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toHaveValue(''));
    expect(navigate).toHaveBeenLastCalledWith({ to: '/chat', search: { view: 'conversation', conversation: latest.id } });
  });

  it('updates the sidebar without taking focus from the composer', async () => {
    const sidebar = mount();
    const composer = await screen.findByRole('combobox', { name: '向 Chat 发送消息' });
    composer.focus();
    await within(sidebar).findByRole('button', { name: '最近的会话 失败' });
    expect(composer).toHaveFocus();
    vi.mocked(api.chatConversations).mockResolvedValue({ items: [{ ...earlier, status: 'running', updatedAt: '2026-11-03T00:00:00Z' }, latest], nextCursor: null });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey }); });
    await waitFor(() => expect(within(sidebar).getAllByRole('button').map((button) => button.textContent)).toEqual(['新对话', '较早的会话', '最近的会话']));
    expect(within(sidebar).getByRole('img', { name: '执行中' })).toBeVisible();
    expect(composer).toHaveFocus();
  });

  it('shows the new conversation before any messages and restores its draft after switching', async () => {
    const sidebar = mount();
    const newConversation = within(sidebar).getByRole('button', { name: '新对话' });
    expect(newConversation).toHaveAttribute('aria-current', 'true');
    const composer = await screen.findByRole('combobox', { name: '向 Chat 发送消息' });
    fireEvent.change(composer, { target: { value: '还没发送的新对话草稿' } });
    fireEvent.click(newConversation);
    expect(composer).toHaveValue('还没发送的新对话草稿');
    fireEvent.click(await within(sidebar).findByRole('button', { name: '最近的会话 失败' }));
    await waitFor(() => expect(api.chatConversation).toHaveBeenLastCalledWith(latest.id));
    expect(newConversation).not.toHaveAttribute('aria-current');
    fireEvent.click(newConversation);
    expect(newConversation).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toHaveValue('还没发送的新对话草稿');
    expect(navigate).toHaveBeenLastCalledWith({ to: '/chat', search: { view: 'conversation', conversation: undefined } });
    fireEvent.change(screen.getByRole('combobox', { name: '向 Chat 发送消息' }), { target: { value: '/new' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: '向 Chat 发送消息' }), { key: 'Enter' });
    expect(screen.getByRole('combobox', { name: '向 Chat 发送消息' })).toHaveValue('');
    expect(newConversation).toHaveAttribute('aria-current', 'true');
  });

  it('uses colored dots without status text and leaves completed conversations with only a title', async () => {
    vi.mocked(api.chatConversations).mockResolvedValue({ items: [], nextCursor: null });
    const sidebar = mount();
    await screen.findByRole('combobox', { name: '向 Chat 发送消息' });
    expect(within(sidebar).getByRole('button', { name: '新对话' })).toBeVisible();
    expect(within(sidebar).queryByText('暂无会话，直接发送消息开始。')).not.toBeInTheDocument();
    queryClient.setQueryData(chatConversationsQueryKey, {
      pages: [{ items: ['running', 'waiting_for_input', 'failed', 'cancelled', 'queued', 'completed'].map((status) => ({ ...earlier, id: status, title: status, status })), nextCursor: null }], pageParams: [undefined],
    });
    await within(sidebar).findByRole('button', { name: 'waiting_for_input 等待你的回答' });
    for (const [status, label, color] of [
      ['running', '执行中', 'bg-brand'],
      ['waiting_for_input', '等待你的回答', 'bg-warning'],
      ['failed', '失败', 'bg-danger'],
      ['cancelled', '已中断', 'bg-muted-foreground'],
      ['queued', '已排队', 'bg-info'],
    ]) {
      const row = within(sidebar).getByRole('button', { name: `${status} ${label}` });
      expect(row).toHaveTextContent(new RegExp(`^${status}$`));
      expect(within(row).getByRole('img', { name: label })).toHaveClass(color);
      expect(within(sidebar).queryByText(label)).not.toBeInTheDocument();
    }
    const completedRow = within(sidebar).getByRole('button', { name: 'completed' });
    expect(completedRow).toHaveTextContent(/^completed$/);
    expect(within(completedRow).queryByRole('img')).not.toBeInTheDocument();
    expect(within(sidebar).queryByText('已完成')).not.toBeInTheDocument();
  });
});
