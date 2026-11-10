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

describe('Chat runtime configuration', () => {
  it('offers native, Codex App Server and Claude Agent SDK runtime choices', () => {
    const onRuntimeChange = vi.fn();
    render(<Configuration {...props()} runtime="native" onRuntimeChange={onRuntimeChange} />);
    const runtime = screen.getByRole('combobox', { name: /^运行时/ });
    fireEvent.keyDown(runtime, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'Codex App Server' }));
    expect(onRuntimeChange).toHaveBeenCalledWith('codex');
  });

  it('allows an engine default without requiring a Provider', () => {
    render(<Configuration {...props()} runtime="claude" />);
    expect(screen.getByRole('combobox', { name: '提供商和模型' })).toHaveTextContent('运行时默认模型');
  });
  it('offers Codex reverse-proxy models to the Codex engine alongside ordinary Responses models', () => {
    const selected = vi.fn();
    const provider = { id: 'proxy', name: 'proxy', protocol: 'codex/responses' as const, baseURL: 'https://example.com', models: ['gpt-test'], apiKey: '', maskedKey: '', headerNames: [], status: 'connected' as const };
    render(<Configuration {...props()} providers={[provider]} runtime="codex" onSelectionChange={selected} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: '提供商和模型' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'proxy / gpt-test' }));
    expect(selected).toHaveBeenCalledWith('proxy::gpt-test');
  });

});
