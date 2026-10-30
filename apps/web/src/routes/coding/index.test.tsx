import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAgentTeamsQuery } from '@/api/queries';
import { Route } from './index';

vi.mock('@/api/queries', () => ({ useAgentTeamsQuery: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: unknown }) => ({ options }),
  Navigate: ({ params }: { params: { executorId: string } }) => <span>{params.executorId}</span>,
}));
afterEach(cleanup);

describe('Coding index', () => {
  it('opens an existing executor without relying on a predefined id', () => {
    vi.mocked(useAgentTeamsQuery).mockReturnValue({ data: [{ id: 'custom-executor' }] } as never);
    const Component = Route.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByText('custom-executor')).toBeTruthy();
  });

  it('shows an empty state when all executors are deleted', () => {
    vi.mocked(useAgentTeamsQuery).mockReturnValue({ data: [] } as never);
    const Component = Route.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByText('暂无执行器。可在 Chat 中创建执行器。')).toBeTruthy();
  });
});
