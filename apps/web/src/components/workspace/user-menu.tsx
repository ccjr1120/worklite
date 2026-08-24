import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Keyboard, LogOut, Palette, UserRound } from 'lucide-react';
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
import { useSessionStore } from '@/stores/session-store';
import { cn } from '@/lib/utils';

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const name = useSessionStore((state) => state.name);
  const email = useSessionStore((state) => state.email);
  const teamSlug = useSessionStore((state) => state.currentTeamSlug);
  const signOut = useSessionStore((state) => state.signOut);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className={cn('h-10 w-full justify-start gap-2 px-2', collapsed && 'justify-center px-0')} aria-label={t('userMenu.label')}>
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-surface-subtle text-[11px] font-medium">
              {name.slice(0, 1) || 'A'}
            </span>
            {collapsed ? null : (
              <span className="min-w-0 text-left">
                <span className="block truncate text-[13px] font-medium">{name || t('userMenu.accountFallback')}</span>
                <span className="block truncate text-xs text-muted-foreground">{email}</span>
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel>{t('userMenu.account')}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to="/$teamSlug/settings/appearance" params={{ teamSlug }}>
              <UserRound className="size-4" />
              {t('userMenu.profile')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/$teamSlug/settings/appearance" params={{ teamSlug }}>
              <Palette className="size-4" />
              {t('userMenu.appearance')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
            <Keyboard className="size-4" />
            {t('userMenu.shortcuts')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              signOut();
              void navigate({ to: '/sign-in' });
            }}
          >
            <LogOut className="size-4" />
            {t('userMenu.signOut')}
          </DropdownMenuItem>
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
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </li>
            <li className="flex items-center justify-between">
              <span>{t('userMenu.signOutHint')}</span>
            </li>
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { UserMenu };
