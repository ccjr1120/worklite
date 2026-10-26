import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { reloadPage } from '@/lib/reload';
import { Sidebar } from './sidebar';

vi.mock('@/app-version', () => ({ APP_VERSION_LABEL: 'v9.9.9' }));

vi.mock('@/lib/reload', () => ({ reloadPage: vi.fn() }));

vi.mock('@/api/queries', () => ({
  useChatConversationsQuery: () => ({ data: undefined }),
}));

const routerState = vi.hoisted(() => ({ pathname: '/chat' }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerState.pathname } }),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  routerState.pathname = '/chat';
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSidebar(
  collapsed: boolean,
  onToggleCollapsed?: () => void,
  onNavigate?: () => void,
) {
  return render(
    <TooltipProvider>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        onNavigate={onNavigate}
      />
    </TooltipProvider>,
  );
}

describe('Sidebar', () => {
  it('shows the app version at the bottom of the expanded sidebar', () => {
    renderSidebar(false);

    const version = screen.getByText('v9.9.9');
    expect(version).toBeVisible();
    expect(version.closest('aside')).not.toBeNull();
  });

  it('keeps the app version visible when the sidebar is collapsed', () => {
    renderSidebar(true);

    expect(screen.getByText('v9.9.9')).toBeVisible();
  });

  it('reloads the page from the brand and version footer', () => {
    renderSidebar(false);

    fireEvent.click(screen.getByRole('button', { name: /v9\.9\.9/ }));

    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('shows plugins, skills, and MCP servers as first-level destinations', () => {
    renderSidebar(false);

    expect(screen.getByRole('link', { name: '插件' })).toHaveAttribute('href', '/plugins');
    expect(screen.getByRole('link', { name: '技能' })).toHaveAttribute('href', '/skills');
    expect(screen.getByRole('link', { name: 'MCP 服务器' })).toHaveAttribute('href', '/mcp-servers');
    expect(screen.queryByRole('link', { name: '全部资源' })).not.toBeInTheDocument();
  });

  it('marks the matching resource destination active on a detail page', () => {
    routerState.pathname = '/mcp-servers/mcp_1';
    renderSidebar(false);

    expect(screen.getByRole('link', { name: 'MCP 服务器' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '插件' })).not.toHaveAttribute('aria-current');
  });

  it('toggles the sidebar from the labeled control at the top', () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar(false, onToggleCollapsed);

    const toggle = screen.getByRole('button', { name: '收起侧边栏' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('shows the expand control and hides text when collapsed', () => {
    renderSidebar(true, vi.fn());

    expect(screen.getByRole('button', { name: '展开侧边栏' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('工作区')).not.toBeInTheDocument();
    expect(screen.queryByText('资源管理')).not.toBeInTheDocument();
    expect(screen.queryByText('配置')).not.toBeInTheDocument();
  });

  it('keeps navigation links clickable when collapsed', () => {
    const onNavigate = vi.fn();
    renderSidebar(true, vi.fn(), onNavigate);

    const plugins = screen.getByRole('link', { name: '插件' });
    expect(plugins).toHaveAttribute('href', '/plugins');
    fireEvent.click(plugins);

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
