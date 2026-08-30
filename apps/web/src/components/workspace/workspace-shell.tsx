import { useEffect, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { Sidebar } from '@/components/workspace/sidebar';
import { ContextBar } from '@/components/workspace/context-bar';
import { CommandMenu } from '@/components/workspace/command-menu';
import { OfflineBanner } from '@/components/workspace/offline-banner';
import { workspaceSlots } from '@/components/workspace/workspace-chrome';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useMediaQuery } from '@/hooks/use-media-query';
import { AgentChat } from '@/components/workspace/agent-chat';

function WorkspaceShell() {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

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
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <Sidebar collapsed={false} onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Sheet>
        ) : (
          <Sidebar collapsed={false} />
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
          />
          <div className="relative min-h-0 flex-1">
            <main className="h-full overflow-auto">
              <Outlet />
            </main>
            <AgentChat workspaceSlug="personal" />
          </div>
        </div>
      </div>
      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}

export { WorkspaceShell };
