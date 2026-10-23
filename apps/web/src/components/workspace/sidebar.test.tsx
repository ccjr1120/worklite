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
  }) => select({ location: { pathname: '/chat' } }),
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSidebar(collapsed: boolean) {
  return render(
    <TooltipProvider>
      <Sidebar collapsed={collapsed} />
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
});
