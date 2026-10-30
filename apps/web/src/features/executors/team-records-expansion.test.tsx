import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TeamRecords } from './team-records';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>, useSearch: () => ({}) }));
vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: () => null }));
vi.mock('@/api/queries', () => ({
  useAgentTeamsQuery: () => ({ data: [] }),
  useAgentTeamRunNodesQuery: () => ({ nodesByRun: new Map(), loading: false, retentionHours: 12 }),
  useAgentTeamRunListQuery: () => ({ isPending: false, isError: false, data: { pages: [{ items: [
    { id: 'running', executorName: 'Executor', status: 'running', intent: 'Active task', projectDirectory: '/repo', createdAt: '2026-10-30T00:00:00Z', finishedAt: null, overview: { durationMs: 1000, totalTokens: { tokens: 15, source: 'exact' } } },
    { id: 'finished', executorName: 'Executor', status: 'succeeded', intent: 'Finished task', projectDirectory: '/repo', createdAt: '2026-10-30T00:00:00Z', finishedAt: '2026-10-30T00:01:00Z', overview: { durationMs: 60000, totalTokens: { tokens: 42, source: 'exact' } } },
  ], total: 2 }] } }),
}));
afterEach(cleanup);

describe('Coding run expansion', () => {
  it('opens in-progress runs, keeps completed runs closed, and respects a manual toggle', () => {
    render(<TooltipProvider><TeamRecords executorId="executor" /></TooltipProvider>);
    const active = screen.getByText('Active task').closest('li')!;
    const finished = screen.getByText('Finished task').closest('li')!;
    expect(active.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    expect(finished.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(active.querySelector('button[aria-expanded]')!);
    expect(active.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
  });
});
