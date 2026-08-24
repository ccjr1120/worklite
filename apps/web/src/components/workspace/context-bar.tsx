import type { ReactNode } from 'react';
import { Menu, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

type ContextBarProps = {
  breadcrumbs: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  status?: ReactNode;
  onOpenCommand: () => void;
  onOpenNavigation?: () => void;
  showMenuButton?: boolean;
};

function ContextBar({
  breadcrumbs,
  primaryAction,
  secondaryActions,
  status,
  onOpenCommand,
  onOpenNavigation,
  showMenuButton,
}: ContextBarProps) {
  const { t } = useTranslation('workspace');

  return (
    <header className="flex h-[52px] items-center gap-3 border-b border-border bg-surface px-3 md:px-4">
      {showMenuButton ? (
        <Button variant="ghost" size="icon-compact" aria-label={t('openNavigation')} onClick={onOpenNavigation}>
          <Menu className="size-4" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{breadcrumbs}</div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="compact" onClick={onOpenCommand} aria-label={t('command.open')} className="hidden sm:inline-flex">
          <Search className="size-3.5" />
          {t('command.search')}
          <Kbd className="ml-1">⌘K</Kbd>
        </Button>
        {status}
        {secondaryActions}
        {primaryAction}
      </div>
    </header>
  );
}

function Breadcrumb({ children, className }: { children: ReactNode; className?: string }) {
  return <nav className={cn('flex items-center gap-1.5 text-foreground', className)}>{children}</nav>;
}

export { ContextBar, Breadcrumb };
export type { ContextBarProps };
