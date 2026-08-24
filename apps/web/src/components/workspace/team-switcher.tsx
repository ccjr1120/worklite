import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { teams } from '@/mock/data';
import { useSessionStore } from '@/stores/session-store';
import { cn } from '@/lib/utils';

function TeamSwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const currentTeamSlug = useSessionStore((state) => state.currentTeamSlug);
  const setTeam = useSessionStore((state) => state.setTeam);
  const team = teams.find((item) => item.slug === currentTeamSlug) ?? teams[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('h-10 w-full justify-between px-2', collapsed && 'justify-center px-0')}
          aria-label={t('teamSwitcher.label')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="inline-flex size-6 items-center justify-center rounded-md bg-brand-subtle text-[11px] font-semibold text-brand">
              {team?.name.slice(0, 1)}
            </span>
            {collapsed ? null : <span className="truncate text-sm font-medium">{team?.name}</span>}
          </span>
          {collapsed ? null : <ChevronsUpDown className="size-3.5 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t('teamSwitcher.teams')}</DropdownMenuLabel>
        {teams.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => {
              setTeam(item.slug);
              void navigate({ to: '/$teamSlug/home', params: { teamSlug: item.slug } });
            }}
          >
            {item.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild>
          <Link to="/onboarding/team">{t('teamSwitcher.createTeam')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { TeamSwitcher };
