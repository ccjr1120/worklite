import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Keyboard, Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { APP_VERSION_LABEL } from '@/app-version';
import { commandShortcutKeys } from '@/lib/platform';

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation('workspace');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={cn('h-10 w-full justify-start gap-2 px-2', collapsed && 'justify-center px-0')} aria-label={t('userMenu.label')}>
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-surface-subtle text-[11px] font-medium">
              P
            </span>
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-medium">{t('userMenu.personalWorkspace')}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t('userMenu.localOnly')}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{APP_VERSION_LABEL}</span>
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel>{t('userMenu.personalWorkspace')}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to="/settings/appearance">
              <Palette className="size-4" />
              {t('userMenu.appearance')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
            <Keyboard className="size-4" />
            {t('userMenu.shortcuts')}
          </DropdownMenuItem>
          {collapsed ? (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{APP_VERSION_LABEL}</div>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('userMenu.shortcuts')}</DialogTitle>
            <DialogDescription>{t('userMenu.shortcutsDescription')}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between">
              <span>{t('userMenu.commandMenu')}</span>
              <span className="flex gap-1">
                {commandShortcutKeys().map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </li>
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { UserMenu };
