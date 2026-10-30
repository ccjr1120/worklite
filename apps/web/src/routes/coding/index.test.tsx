import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCodersQuery } from '@/api/queries';
import { Route } from './index';

vi.mock('@/api/queries', () => ({ useCodersQuery: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: unknown }) => ({ options }),
  Navigate: ({ params }: { params: { coderId: string } }) => <span>{params.coderId}</span>,
}));
afterEach(cleanup);

describe('Coding index', () => {
  it('opens an existing coder without relying on a predefined id', () => {
    vi.mocked(useCodersQuery).mockReturnValue({ data: [{ id: 'custom-coder' }] } as never);
    const Component = Route.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByText('custom-coder')).toBeTruthy();
  });

  it('shows an empty state when all coders are deleted', () => {
    vi.mocked(useCodersQuery).mockReturnValue({ data: [] } as never);
    const Component = Route.options.component as React.ComponentType;
    render(<Component />);
    expect(screen.getByText('暂无 Coder。可在 Chat 中创建 Coder。')).toBeTruthy();
  });
});
