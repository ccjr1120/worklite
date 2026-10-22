import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { ChatProjectTaskView } from '@worklite/contracts';
import { api } from '@/api/client';
import { CodexToolCallPanel } from './transcript';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, api: { ...actual.api, cancelChatProjectTask: vi.fn(), chatProjectTask: vi.fn() } };
});

vi.mock('@/components/locale-provider', () => ({
  useLocale: () => ({ locale: 'zh-CN' }),
}));

afterEach(cleanup);

function task(overrides: Partial<ChatProjectTaskView> = {}): ChatProjectTaskView {
  return {
    executor: 'claude',
    launch: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null },
    id: 'acall_task_card_test',
    executionId: 'aex_1',
    goal: '调查并修复问题',
    projectDirectory: '/tmp/project',
    model: '',
    status: 'running',
    stage: 'working',
    configurationRevision: 1,
    pendingQuestion: null,
    activityCount: 0,
    activityPhases: {},
    activities: [],
    result: '',
    error: null,
    progressText: '检查登录状态\n后续诊断细节',
    steerQueue: [],
    operationCount: 0,
    operationStatuses: {},
    operations: [],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('CodexToolCallPanel project task card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.chatProjectTask).mockResolvedValue(task());
    vi.mocked(api.cancelChatProjectTask).mockResolvedValue(task({ status: 'cancelled', stage: 'cancelled' }));
  });

  it('limits the collapsed summary to goal, elapsed time, status and concise progress', () => {
    const running = task({ steerQueue: [{ id: 'steer_1', text: '保留的历史纠偏', createdAt: '2026-10-21T00:00:01.000Z', status: 'queued' }] });
    render(<CodexToolCallPanel task={running} />);

    expect(screen.getByText('调查并修复问题')).toBeVisible();
    expect(screen.getByText(/已耗时/)).toBeVisible();
    expect(screen.getByText('检查登录状态')).toBeVisible();
    expect(screen.queryByText('/tmp/project')).not.toBeInTheDocument();
    expect(screen.queryByText('后续诊断细节')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '回答' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发送指令' })).not.toBeInTheDocument();
    expect(screen.queryByText('保留的历史纠偏')).not.toBeInTheDocument();
  });

  it('truncates long progress in the summary while keeping the full text in details', async () => {
    const progress = '进展'.repeat(80);
    const running = task({ progressText: progress });
    vi.mocked(api.chatProjectTask).mockResolvedValue(running);
    render(<CodexToolCallPanel task={running} />);

    expect(screen.getByText(`${progress.slice(0, 119)}…`)).toBeVisible();
    expect(screen.queryByText(progress)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开项目任务详情' }));

    expect(await screen.findByText(progress)).toBeVisible();
  });

  it('keeps the summary on one truncated line with the full text available on hover', () => {
    const goal = '第一行目标\n## 第二行细节';
    const running = task({ goal, progressText: '## **检查** 登录状态\n- 后续诊断细节' });
    render(<CodexToolCallPanel task={running} />);

    const goalLine = screen.getByText('第一行目标');
    expect(goalLine).toHaveClass('truncate');
    expect(goalLine).toHaveAttribute('title', goal);
    const progressLine = screen.getByText('检查 登录状态');
    expect(progressLine).toHaveClass('truncate');
    expect(progressLine).toHaveAttribute('title', '检查 登录状态');
  });

  it('renders executor output as sanitized Markdown in the expanded details', async () => {
    const completed = task({
      status: 'succeeded',
      stage: 'succeeded',
      progressText: '',
      result: '## 结果标题\n\n- **加粗项**\n- `行内代码`\n\n[链接](https://example.com)\n\n<script data-xss="1">alert(1)</script>\n\n[坏链接](javascript:alert(1))',
      error: '**失败原因**',
    });
    vi.mocked(api.chatProjectTask).mockResolvedValue(completed);
    const { container } = render(<CodexToolCallPanel task={completed} />);
    fireEvent.click(screen.getByRole('button', { name: '展开项目任务详情' }));

    expect(await screen.findByRole('heading', { name: '结果标题' })).toBeVisible();
    expect(screen.getByText('加粗项')).toHaveAttribute('data-streamdown', 'strong');
    expect(screen.getByText('行内代码').tagName).toBe('CODE');
    expect(screen.getByText('失败原因')).toHaveAttribute('data-streamdown', 'strong');
    // Raw HTML is dropped and unsafe URLs never become clickable links.
    expect(container.querySelector('script, [data-xss]')).toBeNull();
    expect(screen.getAllByRole('button', { name: /链接/ }).map((link) => link.textContent)).toEqual(['链接']);
    expect(container.innerHTML).not.toMatch(/href="javascript:/i);
  });

  it('keeps task questions read-only and places the question in expanded details', async () => {
    const waiting = task({
      status: 'waiting_for_input',
      stage: 'waiting',
      pendingQuestion: { id: 'question_1', projectTaskId: 'acall_task_card_test', question: '应该检查哪种登录方式？', options: [], createdAt: '2026-10-21T00:00:01.000Z' },
    });
    vi.mocked(api.chatProjectTask).mockResolvedValue(waiting);
    render(<CodexToolCallPanel task={waiting} />);

    expect(screen.queryByText('应该检查哪种登录方式？')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开项目任务详情' }));

    expect(await screen.findByText('应该检查哪种登录方式？')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '回答' })).not.toBeInTheDocument();
  });

  it('does not show a terminal result until the reader opens task details', async () => {
    const completed = task({ status: 'succeeded', stage: 'succeeded', result: '完整任务结果只在详情中显示。' });
    vi.mocked(api.chatProjectTask).mockResolvedValue(completed);
    render(<CodexToolCallPanel task={completed} />);

    expect(screen.queryByText('完整任务结果只在详情中显示。')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '展开项目任务详情' }));

    expect(await screen.findByText('完整任务结果只在详情中显示。')).toBeVisible();
    await waitFor(() => expect(api.chatProjectTask).toHaveBeenCalledWith('acall_task_card_test', 'full'));
  });

  it('keeps historical steer evidence available in expanded details', async () => {
    const historical = task({
      status: 'succeeded',
      stage: 'succeeded',
      steerQueue: [{ id: 'steer_1', text: '保留的历史纠偏', createdAt: '2026-10-21T00:00:01.000Z', status: 'queued' }],
    });
    vi.mocked(api.chatProjectTask).mockResolvedValue(historical);
    render(<CodexToolCallPanel task={historical} />);

    expect(screen.queryByText('保留的历史纠偏')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开项目任务详情' }));

    expect(await screen.findByText('保留的历史纠偏')).toBeVisible();
  });

  it('requires confirmation before cancellation and shows the returned task state', async () => {
    const cancelled = task({ status: 'cancelled', stage: 'cancelled', progressText: '' });
    vi.mocked(api.cancelChatProjectTask).mockResolvedValue(cancelled);
    render(<CodexToolCallPanel task={task()} />);

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    expect(screen.getByText('确认停止当前执行？')).toBeVisible();
    expect(api.cancelChatProjectTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认取消' }));

    await waitFor(() => expect(api.cancelChatProjectTask).toHaveBeenCalledWith('acall_task_card_test'));
    expect(await screen.findByText('已取消')).toBeVisible();
    expect(screen.queryByText('确认停止当前执行？')).not.toBeInTheDocument();
  });

  it('shows local cancellation progress while the server request is pending', async () => {
    let resolveCancellation!: (value: ChatProjectTaskView) => void;
    vi.mocked(api.cancelChatProjectTask).mockReturnValue(new Promise((resolve) => { resolveCancellation = resolve; }));
    render(<CodexToolCallPanel task={task()} />);

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消' }));
    expect(screen.getByRole('button', { name: '正在取消…' })).toBeDisabled();

    resolveCancellation(task({ status: 'cancelled', stage: 'cancelled', progressText: '' }));
    expect(await screen.findByText('已取消')).toBeVisible();
  });

  it('keeps cancellation confirmation open and reports a cancellation failure', async () => {
    vi.mocked(api.cancelChatProjectTask).mockRejectedValue(new Error('network down'));
    render(<CodexToolCallPanel task={task()} />);

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('无法取消任务，请重试。');
    expect(screen.getByText('确认停止当前执行？')).toBeVisible();
  });

  it('keeps cancellation confirmation open when the server still reports an active task', async () => {
    vi.mocked(api.cancelChatProjectTask).mockResolvedValue(task());
    render(<CodexToolCallPanel task={task()} />);

    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('取消请求已返回，但任务仍在运行。请先查看任务状态后再试。');
    expect(screen.getByText('确认停止当前执行？')).toBeVisible();
  });
});
