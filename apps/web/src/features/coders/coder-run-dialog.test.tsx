import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { CoderRunDialog } from './coder-run-detail';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/chat">{children}</a> }));
vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/api/queries', () => ({ agentTeamRunQueryKey: (id: string) => ['run', id], useAgentTeamRunQuery: () => ({ isPending: true }) }));
vi.stubGlobal('EventSource', class { close() {} });
afterEach(cleanup);

describe('execution details dialog', () => {
  it('opens from its trigger and closes without navigation', () => {
    render(<QueryClientProvider client={new QueryClient()}><CoderRunDialog runId="run_1"><button>查看</button></CoderRunDialog></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('status')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
