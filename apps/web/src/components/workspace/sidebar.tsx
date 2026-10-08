import { Link, useRouterState } from '@tanstack/react-router';
import { MessageSquareText, KeyRound, Puzzle, ScrollText, Settings, UsersRound, Workflow } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatConversationsQuery } from '@/api/queries';
import { isLiveStatus } from '@/components/status-badge';
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
      { id: 'chat', labelKey: 'nav.chat', to: '/chat', icon: MessageSquareText },
      { id: 'workflows', labelKey: 'nav.workflows', to: '/workflows', icon: Workflow },
      { id: 'agentTeam', labelKey: 'nav.agentTeam', to: '/agent-teams/$teamId', icon: UsersRound },
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

type NavItem = (typeof navigationGroups)[number]['items'][number];

// The live dot reads the same server conversation list the Chat page polls, so it is
// shared cache rather than a second source of truth.
function useChatLive() {
  const query = useChatConversationsQuery();
  return (query.data?.pages[0]?.items ?? []).some((item) => isLiveStatus(item.status));
}

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation('workspace');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chatLive = useChatLive();
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);

  function primaryActive(id: NavItem['id'], to: string) {
    if (id === 'settings') return pathname.startsWith('/settings');
    if (id === 'workflows') return ['/workflows', '/artifacts', '/runs'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (id === 'agentTeam') return ['/agent-teams', '/agent-team-runs'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (id === 'plugins') return ['/plugins', '/skills', '/mcp-servers'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  // One selection pill glides between items instead of each item toggling its own fill.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>('a[aria-current="page"]');
      setPill(active ? { top: active.offsetTop, height: active.offsetHeight } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname, collapsed]);

  function primaryLink(item: NavItem) {
    const active = primaryActive(item.id, item.to);
    const live = item.id === 'chat' && chatLive;
    const content = (
      <Link
        to={item.to}
        params={item.id === 'agentTeam' ? { teamId: 'agent_team_bmad_tea' } : undefined}
        search={item.id === 'agentTeam' ? { tab: 'conversation' } : undefined}
        onClick={onNavigate}
        className={cn(
          'wl-press relative z-[1] flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px]',
          collapsed && 'justify-center px-0',
          active ? 'font-medium text-foreground' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
          focusRingInset,
        )}
        aria-current={active ? 'page' : undefined}
      >
        <span className="relative flex shrink-0">
          <item.icon className={cn('size-[18px] transition-colors duration-[140ms]', active && 'text-brand')} aria-hidden="true" />
          {live && collapsed ? <span className="wl-live absolute -right-1 -top-1 !size-2 text-brand ring-2 ring-surface" aria-hidden="true" /> : null}
        </span>
        {collapsed ? <span className="sr-only">{t(item.labelKey)}</span> : <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>}
        {live && !collapsed ? <span className="wl-live mr-1 text-brand" aria-hidden="true" /> : null}
        {live ? <span className="sr-only">{t('nav.live')}</span> : null}
      </Link>
    );
    return collapsed ? <Tooltip><TooltipTrigger asChild>{content}</TooltipTrigger><TooltipContent side="right">{t(item.labelKey)}</TooltipContent></Tooltip> : content;
  }

  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-[280ms] ease-[var(--ease-out)]', collapsed ? 'w-14' : 'w-[240px]')}>
      <div className={cn('flex h-14 items-center px-3', collapsed && 'justify-center px-2')}>
        <Link to="/chat" aria-label="WorkLite" className={cn('wl-press flex items-center gap-2.5 rounded-md p-1', focusRingInset)}>
          <span className="flex size-8 items-center justify-center rounded-md bg-brand-subtle">
            <WorkLiteMark className="size-6" />
          </span>
          {collapsed ? null : <span className="text-[15px] font-semibold tracking-[-0.01em]">WorkLite</span>}
        </Link>
      </div>
      <nav ref={navRef} className="relative flex-1 overflow-y-auto px-2 pb-3 pt-2" aria-label={t('nav.title')}>
        {pill ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-2 rounded-md bg-brand-subtle transition-[top,height] duration-[280ms] ease-[var(--ease-out)]"
            style={{ top: pill.top, height: pill.height }}
          />
        ) : null}
        <div className="flex flex-col gap-5">
          {navigationGroups.map((group, groupIndex) => (
            <section key={group.id} aria-labelledby={collapsed ? undefined : `sidebar-${group.id}`} className="flex flex-col gap-0.5">
              {collapsed ? (
                groupIndex > 0 ? <div className="mx-2 mb-2 h-px bg-border" aria-hidden="true" /> : null
              ) : (
                <p id={`sidebar-${group.id}`} className="px-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground">
                  {t(group.labelKey)}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
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
