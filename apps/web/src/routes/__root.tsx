import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { LocaleProvider } from '@/components/locale-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isOnboarding = pathname.startsWith('/onboarding');
  return (
    <LocaleProvider>
      <ThemeProvider>
        <TooltipProvider>
          <div className="min-h-screen bg-background text-foreground">
          {isOnboarding ? <Outlet /> : <WorkspaceShell />}
          </div>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
