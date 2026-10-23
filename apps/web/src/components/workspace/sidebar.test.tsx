import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from './sidebar';

vi.mock('@/app-version', () => ({ APP_VERSION_LABEL: 'v9.9.9' }));

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
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
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
});
