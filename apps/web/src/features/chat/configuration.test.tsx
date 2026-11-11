import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { Configuration } from './configuration';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const props = () => ({
  providers: [], skills: [], selectedSkillIds: [], onSkillIdsChange: vi.fn(), skillsLoading: false, skillsLoadFailed: false,
  selection: '', onSelectionChange: vi.fn(), extensionPrompt: '', onPromptChange: vi.fn(), onPromptSave: vi.fn(), summarizePrompt: '', onSummarizePromptChange: vi.fn(), onSummarizePromptSave: vi.fn(),
  turnNotificationsEnabled: false, turnNotificationSound: '', onTurnNotificationsChange: vi.fn(), saving: false, loading: false, error: '', loadFailed: false, providersLoading: false, providersLoadFailed: false, onReload: vi.fn(),
});

describe('native-only Chat configuration', () => {
  it('requires a Provider model and has no engine runtime selector', () => {
    render(<Configuration {...props()} />);
    expect(screen.queryByRole('combobox', { name: /^运行时/ })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '提供商和模型' })).not.toHaveTextContent('运行时默认模型');
    expect(screen.queryByText('Codex App Server')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Agent SDK')).not.toBeInTheDocument();
  });
  it('offers configured models including codex/responses Providers to native Chat', () => {
    const selected = vi.fn();
    const provider = { id: 'proxy', name: 'proxy', protocol: 'codex/responses' as const, baseURL: 'https://example.com', models: ['gpt-test'], apiKey: '', maskedKey: '', headerNames: [], status: 'connected' as const };
    render(<Configuration {...props()} providers={[provider]} onSelectionChange={selected} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: '提供商和模型' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'proxy / gpt-test' }));
    expect(selected).toHaveBeenCalledWith('proxy::gpt-test');
  });
});
