import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import type { CodexAuthStatus, ModelProviderView } from '@worklite/contracts';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route } from './model-providers';

const providers: ModelProviderView[] = [
  { id: 'p_codex', name: 'codex', baseURL: 'https://chatgpt.com', protocol: 'codex/responses', status: 'connected', apiKey: '', maskedKey: '', models: ['gpt-5'], headerNames: [] },
  { id: 'p_openai', name: 'openai-main', baseURL: 'https://api.openai.com/v1', protocol: 'openai/chat', status: 'connected', apiKey: 'sk-test', maskedKey: 'sk-***', models: ['gpt-4o'], headerNames: [] },
];

const codexAuth: CodexAuthStatus = {
  status: 'connected',
  authMethod: 'oauth',
  email: null,
  accountId: null,
  planType: null,
  expiresAt: null,
  accounts: [{ id: 'acc_1', name: 'pool-account@example.com', enabled: true, autoPauseOnExpired: false, concurrency: 2, priority: 1, rateMultiplier: 1, email: 'pool-account@example.com', accountId: 'acct_123456789', planType: 'plus', expiresAt: null, status: 'connected' }],
};

vi.mock('@/api/queries', () => ({
  useModelProvidersQuery: () => ({ data: providers, isLoading: false, isError: false, refetch: vi.fn() }),
  usePortkeyGatewayQuery: () => ({ data: undefined }),
  useCodexAuthQuery: () => ({ data: codexAuth, refetch: vi.fn() }),
  useCodexAccountUsagesQuery: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/api/client', () => ({ ApiError: class extends Error {}, api: {} }));
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn(() => Promise.resolve()) } }));
vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('@/components/workspace/workspace-chrome', () => ({ WorkspaceChrome: () => null }));
vi.mock('@/features/logs/gateway-statistics', () => ({ GatewayStatistics: () => null }));
vi.mock('@/features/logs/request-logs', () => ({ GatewayRequestLogs: () => null }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  createFileRoute: () => (options: { component: unknown; validateSearch: unknown }) => ({ options, useSearch: () => ({}) }),
}));

afterEach(cleanup);

const ModelProvidersPage = (Route as unknown as { options: { component: () => React.ReactElement } }).options.component;

function renderPage() {
  return render(<TooltipProvider><ModelProvidersPage /></TooltipProvider>);
}

function rowOf(providerName: string): HTMLElement {
  const row = screen.getByRole('button', { name: new RegExp(providerName) }).parentElement;
  if (!row) throw new Error(`row for ${providerName} not found`);
  return row;
}

describe('model providers page', () => {
  it('has no standalone Codex account pool tab', () => {
    renderPage();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex 账号池')).not.toBeInTheDocument();
  });

  it('opens the Codex account pool from the Codex provider edit action', () => {
    renderPage();
    fireEvent.click(within(rowOf('codex')).getByRole('button', { name: '编辑提供商' }));
    const dialog = screen.getByRole('dialog', { name: '编辑 Codex 提供商' });
    expect(within(dialog).getByText('pool-account@example.com')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Add account/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Import JSON/ })).toBeInTheDocument();
  });

  it('keeps other providers on the regular edit form without a pool entry', () => {
    renderPage();
    fireEvent.click(within(rowOf('openai-main')).getByRole('button', { name: '编辑提供商' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('API 密钥')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Codex 账号池' })).not.toBeInTheDocument();
    expect(screen.queryByText('pool-account@example.com')).not.toBeInTheDocument();
  });
});
