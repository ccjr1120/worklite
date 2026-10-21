import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { ChatProjectTaskView } from '@worklite/contracts';
import { api } from '@/api/client';
import { CodexToolCallPanel } from './transcript';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, api: { ...actual.api, steerChatProjectTask: vi.fn(), chatProjectTask: vi.fn() } };
});

vi.mock('@/components/locale-provider', () => ({
  useLocale: () => ({ locale: 'zh-CN' }),
}));

afterEach(cleanup);

function task(overrides: Partial<ChatProjectTaskView> = {}): ChatProjectTaskView {
  return {
    executor: 'claude',
    launch: { executor: 'claude', commandArguments: [], baseUrl: 'http://127.0.0.1:23392', model: null },
    id: 'acall_steer_test',
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
    progressText: '',
    steerQueue: [],
    operationCount: 0,
    operationStatuses: {},
    operations: [],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('CodexToolCallPanel steer composer', () => {
  it('shows the steer composer for a running task and submits a correction without cancelling it', async () => {
    const updated = task({ steerQueue: [{ id: 'steer_1', text: '改成只读调查', createdAt: '2026-10-21T00:00:01.000Z', status: 'queued' }] });
    vi.mocked(api.steerChatProjectTask).mockResolvedValue(updated);

    render(<CodexToolCallPanel task={task()} />);

    const textbox = screen.getByPlaceholderText('无需取消任务，直接输入纠偏或补充指令…');
    fireEvent.change(textbox, { target: { value: '改成只读调查' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));

    await waitFor(() => expect(api.steerChatProjectTask).toHaveBeenCalledWith('acall_steer_test', { text: '改成只读调查' }));
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('已记录，将在当前轮次结束后自动带入下一轮次执行。')).toBeInTheDocument());
  });

  it('shows a delivered notice when the server reports the instruction reached the live turn', async () => {
    const updated = task({ steerQueue: [{ id: 'steer_1', text: '改成只读调查', createdAt: '2026-10-21T00:00:01.000Z', status: 'delivered' }] });
    vi.mocked(api.steerChatProjectTask).mockResolvedValue(updated);

    render(<CodexToolCallPanel task={task()} />);
    fireEvent.change(screen.getByPlaceholderText('无需取消任务，直接输入纠偏或补充指令…'), { target: { value: '改成只读调查' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));

    await waitFor(() => expect(screen.getByText('已直接送达当前执行轮次。')).toBeInTheDocument());
  });

  it('does not show the steer composer once the task has settled', () => {
    render(<CodexToolCallPanel task={task({ status: 'succeeded', stage: 'succeeded' })} />);
    expect(screen.queryByPlaceholderText('无需取消任务，直接输入纠偏或补充指令…')).not.toBeInTheDocument();
  });

  it('surfaces the server error when steering fails', async () => {
    vi.mocked(api.steerChatProjectTask).mockRejectedValue(new Error('network down'));

    render(<CodexToolCallPanel task={task()} />);
    fireEvent.change(screen.getByPlaceholderText('无需取消任务，直接输入纠偏或补充指令…'), { target: { value: '改成只读调查' } });
    fireEvent.click(screen.getByRole('button', { name: '发送指令' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法提交指令，请重试。'));
  });
});
