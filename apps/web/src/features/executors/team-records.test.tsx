import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TeamRecords } from './team-records';

const listQuery = vi.fn();
const fetchNextPage = vi.fn();
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>, useSearch: () => ({}) }));
vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: () => null }));
vi.mock('./team-run-detail', () => ({ TeamRunDialog: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/api/queries', () => ({
  useAgentTeamsQuery: () => ({ data: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] }),
  useAgentTeamRunNodesQuery: () => ({ nodesByRun: new Map(), loading: false, retentionHours: 12 }),
  useAgentTeamRunListQuery: (ids: string[]) => listQuery(ids),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Coding records', () => {
  it('starts with all executors, loads further pages, and permits filtering', async () => {
    listQuery.mockReturnValue({ isPending: false, isError: false, isFetching: false, hasNextPage: true, fetchNextPage, data: { pages: [{ items: [], total: 2 }] } });
    render(<TooltipProvider><TeamRecords executorId="one" /></TooltipProvider>);
    expect(listQuery).toHaveBeenCalledWith([]);
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /执行器/ }));
    fireEvent.click(screen.getByLabelText('Two'));
    expect(listQuery).toHaveBeenLastCalledWith(['two']);
  });
});
