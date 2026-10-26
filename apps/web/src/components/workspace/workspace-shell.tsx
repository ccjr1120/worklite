import { useEffect, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '@/components/workspace/sidebar';
import { ContextBar } from '@/components/workspace/context-bar';
import { CommandMenu } from '@/components/workspace/command-menu';
import { OfflineBanner } from '@/components/workspace/offline-banner';
import { workspaceSlots } from '@/components/workspace/workspace-chrome';
import {
  readSidebarCollapsedPreference,
  storeSidebarCollapsedPreference,
} from '@/components/workspace/sidebar-preference';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useMediaQuery } from '@/hooks/use-media-query';

function WorkspaceShell() {
  const { t } = useTranslation('workspace');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isWide = useMediaQuery('(min-width: 1024px)');
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [collapsedPreference, setCollapsedPreference] = useState<boolean | null>(
    readSidebarCollapsedPreference,
  );
  const collapsed = collapsedPreference ?? (!isWide && !isMobile);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  function toggleSidebar() {
    const nextCollapsed = !collapsed;
    setCollapsedPreference(nextCollapsed);
    storeSidebarCollapsedPreference(nextCollapsed);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background">
      <OfflineBanner />
      <div className="flex min-h-0 flex-1">
        {isMobile ? (
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetContent side="left" className="p-0 sm:max-w-[232px]">
              <SheetHeader className="sr-only">
                <SheetTitle>{t('nav.title')}</SheetTitle>
              </SheetHeader>
              <Sidebar collapsed={false} onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>
        ) : (
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <ContextBar
            breadcrumbs={<div id={workspaceSlots.crumbs} className="min-w-0" />}
            status={<div id={workspaceSlots.status} className="flex items-center" />}
            secondaryActions={null}
            primaryAction={<div id={workspaceSlots.actions} className="flex items-center gap-2" />}
            onOpenCommand={() => setCommandOpen(true)}
            onOpenNavigation={() => setMobileNavOpen(true)}
            showMenuButton={isMobile}
            showSearch={pathname !== '/chat'}
          />
          <div className="relative min-h-0 min-w-0 flex-1">
            <main className="wl-page h-full overflow-auto">
              <Outlet />
            </main>
          </div>
        </div>
      </div>
      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}

export { WorkspaceShell };
