import { createRootRoute } from '@tanstack/react-router';
import { LocaleProvider } from '@/components/locale-provider';
import { RouteError, RoutePending } from '@/components/route-boundaries';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { WorkspaceShell } from '@/components/workspace/workspace-shell';

export const Route = createRootRoute({
  component: RootLayout,
  pendingComponent: RoutePending,
  errorComponent: RouteError,
});

function RootLayout() {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <TooltipProvider>
          <div className="min-h-screen bg-background text-foreground">
            <WorkspaceShell />
          </div>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
