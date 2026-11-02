import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CoderRecords } from './coder-records';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>, useSearch: () => ({}) }));
vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: () => null }));
vi.mock('@/api/queries', () => ({
  useCodersQuery: () => ({ data: [] }),
  useAgentTeamRunNodesQuery: () => ({ nodesByRun: new Map([['running', [{ nodeRunId: 'n1', name: 'Planner', role: 'planner', status: 'running', durationMs: 1000, attemptIndex: 0, tokens: { tokens: 15, source: 'exact' } }]], ['finished', [{ nodeRunId: 'n2', name: 'Planner', role: 'planner', status: 'completed', durationMs: 1000, attemptIndex: 0, tokens: { tokens: 42, source: 'exact' } }]]]), loading: false, retentionHours: 12 }),
  useAgentTeamRunListQuery: () => ({ isPending: false, isError: false, data: { pages: [{ items: [
    { id: 'running', coderName: 'Executor', status: 'running', intent: 'Active task', projectDirectory: '/repo', createdAt: '2026-10-30T00:00:00Z', finishedAt: null, overview: { durationMs: 1000, totalTokens: { tokens: 15, source: 'exact' } } },
    { id: 'finished', coderName: 'Executor', status: 'succeeded', intent: 'Finished task', projectDirectory: '/repo', createdAt: '2026-10-30T00:00:00Z', finishedAt: '2026-10-30T00:01:00Z', overview: { durationMs: 60000, totalTokens: { tokens: 42, source: 'exact' } } },
  ], total: 2 }] } }),
}));
afterEach(cleanup);

describe('Coding run overview', () => {
  it('shows every run overview without expansion controls and offers actions for active runs', () => {
    render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><CoderRecords coderId="executor" /></TooltipProvider></QueryClientProvider>);
    const active = screen.getByText('Active task').closest('li')!;
    const finished = screen.getByText('Finished task').closest('li')!;
    expect(active.querySelector('section')).not.toBeNull();
    expect(finished.querySelector('section')).not.toBeNull();
    expect(active.querySelector('button[aria-expanded]')).toBeNull();
    expect(finished.querySelector('button[aria-expanded]')).toBeNull();
    expect(active.querySelectorAll('button').length).toBe(2);
    expect(finished.querySelectorAll('button').length).toBe(0);
  });
});
