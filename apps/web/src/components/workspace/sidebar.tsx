import { Link, useRouterState } from '@tanstack/react-router';
import { Home, KeyRound, Puzzle, ScrollText, Settings, UsersRound, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { focusRingInset } from '@/components/ui/interaction';
import { UserMenu } from '@/components/workspace/user-menu';
import { WorkLiteMark } from '@/components/worklite-mark';
import { cn } from '@/lib/utils';

const navigationGroups = [
  {
    id: 'workspace',
    labelKey: 'nav.workspace',
    items: [
      { id: 'home', labelKey: 'nav.home', to: '/home', icon: Home },
      { id: 'workflows', labelKey: 'nav.workflows', to: '/workflows', icon: Workflow },
      { id: 'agentTeam', labelKey: 'nav.agentTeam', to: '/agent-teams/agent_team_bmad_tea', icon: UsersRound },
    ],
  },
  {
    id: 'capabilities',
    labelKey: 'nav.capabilities',
    items: [
      { id: 'plugins', labelKey: 'nav.plugins', to: '/plugins', icon: Puzzle },
    ],
  },
  {
    id: 'configuration',
    labelKey: 'nav.configuration',
    items: [
      { id: 'providers', labelKey: 'nav.modelProviders', to: '/model-providers', icon: KeyRound },
      { id: 'logs', labelKey: 'nav.logs', to: '/logs', icon: ScrollText },
      { id: 'settings', labelKey: 'nav.settings', to: '/settings/appearance', icon: Settings },
    ],
  },
] as const;

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation('workspace');
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  function primaryActive(id: (typeof navigationGroups)[number]['items'][number]['id'], to: string) {
    if (id === 'settings') return pathname.startsWith('/settings');
    if (id === 'workflows') return ['/workflows', '/artifacts'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (id === 'agentTeam') return ['/agent-teams', '/agent-team-runs'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  function primaryLink(item: (typeof navigationGroups)[number]['items'][number]) {
    const active = primaryActive(item.id, item.to);
    const content = (
      <Link
        to={item.to}
        onClick={onNavigate}
        className={cn(
          'relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-[120ms]',
          collapsed && 'justify-center px-0',
          active ? 'bg-brand-subtle font-medium text-foreground' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
          focusRingInset,
        )}
        aria-current={active ? 'page' : undefined}
      >
        {active ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-brand" aria-hidden="true" /> : null}
        <item.icon className="size-[18px] shrink-0" aria-hidden="true" />
        {collapsed ? <span className="sr-only">{t(item.labelKey)}</span> : <span className="truncate">{t(item.labelKey)}</span>}
      </Link>
    );
    return collapsed ? <Tooltip><TooltipTrigger asChild>{content}</TooltipTrigger><TooltipContent side="right">{t(item.labelKey)}</TooltipContent></Tooltip> : content;
  }

  return (
    <aside className={cn('flex h-full flex-col border-r border-border bg-surface', collapsed ? 'w-14' : 'w-[232px]')}>
      <div className={cn('flex h-[52px] items-center border-b border-border px-2', collapsed && 'justify-center')}>
        <Link to="/home" aria-label="WorkLite" className="flex items-center gap-2">
          <WorkLiteMark className={collapsed ? 'size-5' : 'size-6'} />
          {collapsed ? null : <span className="text-sm font-semibold">WorkLite</span>}
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label={t('nav.title')}>
        <div className="flex flex-col gap-4">
          {navigationGroups.map((group, groupIndex) => (
            <section key={group.id} aria-labelledby={collapsed ? undefined : `sidebar-${group.id}`} className="flex flex-col gap-0.5">
              {collapsed ? (
                groupIndex > 0 ? <div className="mx-2 mb-2 h-px bg-border" aria-hidden="true" /> : null
              ) : (
                <p id={`sidebar-${group.id}`} className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  {t(group.labelKey)}
                </p>
              )}
              <ul>
                {group.items.map((item) => <li key={item.id}>{primaryLink(item)}</li>)}
              </ul>
            </section>
          ))}
        </div>
      </nav>
      <div className="border-t border-border p-2"><UserMenu collapsed={collapsed} /></div>
    </aside>
  );
}

export { Sidebar };
