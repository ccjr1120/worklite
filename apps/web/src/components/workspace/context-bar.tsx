import type { ReactNode } from 'react';
import { Menu, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { commandShortcutLabel } from '@/lib/platform';

type ContextBarProps = {
  breadcrumbs: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  status?: ReactNode;
  onOpenCommand: () => void;
  onOpenNavigation?: () => void;
  showMenuButton?: boolean;
  showSearch?: boolean;
};

// The bar floats over scrolling content with a translucent blurred surface.
function ContextBar({
  breadcrumbs,
  primaryAction,
  secondaryActions,
  status,
  onOpenCommand,
  onOpenNavigation,
  showMenuButton,
  showSearch = true,
}: ContextBarProps) {
  const { t } = useTranslation('workspace');

  return (
    <header className="wl-context-bar relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 md:px-5">
      {showMenuButton ? (
        <Button variant="ghost" size="icon-compact" aria-label={t('openNavigation')} onClick={onOpenNavigation}>
          <Menu className="size-4" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{breadcrumbs}</div>
      <div className="flex min-w-0 items-center gap-2">
        {status}
        {showSearch ? (
          <>
            <Button
              variant="ghost"
              size="icon-compact"
              onClick={onOpenCommand}
              aria-label={t('command.open')}
              className="sm:hidden"
            >
              <Search className="size-4" />
            </Button>
            <button
              type="button"
              onClick={onOpenCommand}
              aria-label={t('command.open')}
              className="wl-press hidden h-8 w-56 items-center gap-2 rounded-md bg-surface-subtle/60 pl-3 pr-1.5 text-[13px] text-muted-foreground hover:bg-surface-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 lg:inline-flex"
            >
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">{t('command.search')}</span>
              <Kbd className="shrink-0">{commandShortcutLabel()}</Kbd>
            </button>
            <Button variant="ghost" size="icon-compact" onClick={onOpenCommand} aria-label={t('command.open')} className="hidden sm:inline-flex lg:hidden">
              <Search className="size-4" />
            </Button>
          </>
        ) : null}
        {secondaryActions}
        {primaryAction}
      </div>
    </header>
  );
}

export { ContextBar };
