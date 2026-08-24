import { createRootRoute, Outlet } from '@tanstack/react-router';
import { LocaleProvider } from '@/components/locale-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <TooltipProvider>
          <div className="min-h-screen bg-background text-foreground">
            <Outlet />
          </div>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
