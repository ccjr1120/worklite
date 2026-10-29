import { Link, useRouterState } from '@tanstack/react-router';
import {
  Blocks,
  Code2,
  FileText,
  KeyRound,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Puzzle,
  ScrollText,
  Server,
  Settings,
  Workflow,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatConversationsQuery } from '@/api/queries';
import { APP_VERSION_LABEL } from '@/app-version';
import { isLiveStatus } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { focusRingInset } from '@/components/ui/interaction';
import { WorkLiteMark } from '@/components/worklite-mark';
import { reloadPage } from '@/lib/reload';
import { cn } from '@/lib/utils';

const navigationGroups = [
  {
    id: 'workspace',
    labelKey: 'nav.workspace',
    items: [
      { id: 'chat', labelKey: 'nav.chat', to: '/chat', icon: MessageSquareText },
      { id: 'workflows', labelKey: 'nav.workflows', to: '/workflows', icon: Workflow },
      { id: 'agentTeam', labelKey: 'nav.agentTeam', to: '/executor-categories', icon: Code2 },
    ],
  },
  {
    id: 'resources',
    labelKey: 'nav.resourceManagement',
    items: [
      { id: 'plugins', labelKey: 'nav.plugins', to: '/plugins', icon: Puzzle },
      { id: 'skills', labelKey: 'nav.skills', to: '/skills', icon: Blocks },
      { id: 'mcpServers', labelKey: 'nav.mcpServers', to: '/mcp-servers', icon: Server },
      { id: 'artifacts', labelKey: 'nav.artifacts', to: '/artifacts', icon: FileText },
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

function Sidebar({
  collapsed,
  onNavigate,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  onToggleCollapsed?: () => void;
}) {
  const { t } = useTranslation('workspace');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chatLive = useChatLive();
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);

  function primaryActive(id: NavItem['id'], to: string) {
    if (id === 'settings') return pathname.startsWith('/settings');
    if (id === 'workflows') return ['/workflows', '/runs'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (id === 'agentTeam') return ['/executor-categories', '/executor-runs'].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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
    const label = t(item.labelKey);
    const accessibleLabel = live ? `${label} · ${t('nav.live')}` : label;
    const content = (
      <Link
        to={item.to}
        onClick={onNavigate}
        aria-label={accessibleLabel}
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
        {!collapsed ? <span className="min-w-0 flex-1 truncate">{label}</span> : null}
        {live && !collapsed ? <span className="wl-live mr-1 text-brand" aria-hidden="true" /> : null}
      </Link>
    );
    return collapsed ? <Tooltip><TooltipTrigger asChild>{content}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip> : content;
  }

  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-[280ms] ease-[var(--ease-out)]', collapsed ? 'w-14' : 'w-[240px]')}>
      {onToggleCollapsed ? (
        <div className={cn('flex h-14 shrink-0 items-center border-b border-border px-2', collapsed ? 'justify-center px-1.5' : 'justify-between pl-3')}>
          {!collapsed ? <span className="text-[11px] font-medium text-muted-foreground">{t('nav.title')}</span> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-compact"
                onClick={onToggleCollapsed}
                aria-label={t(collapsed ? 'expandNavigation' : 'collapseNavigation')}
                aria-expanded={!collapsed}
                aria-controls="workspace-sidebar-navigation"
                className="text-muted-foreground hover:text-foreground"
              >
                {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t(collapsed ? 'expandNavigation' : 'collapseNavigation')}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      <nav id="workspace-sidebar-navigation" ref={navRef} className="relative flex-1 overflow-y-auto px-2 pb-3 pt-3" aria-label={t('nav.title')}>
        {pill ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-2 rounded-md bg-brand-subtle transition-[top,height] duration-[280ms] ease-[var(--ease-out)]"
            style={{ top: pill.top, height: pill.height }}
          />
        ) : null}
        <div className="flex flex-col gap-5">
          {navigationGroups.map((group, groupIndex) => (
            <section
              key={group.id}
              aria-label={collapsed ? t(group.labelKey) : undefined}
              aria-labelledby={collapsed ? undefined : `sidebar-${group.id}`}
              className="flex flex-col gap-0.5"
            >
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
      {/* The footer carries the brand mark and build version as one reload control, so the
          identity is visible without a separate header row. */}
      <div className={cn('shrink-0 border-t border-border p-2', collapsed && 'px-1.5')}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={reloadPage}
              aria-label={`${t('reload')} · ${APP_VERSION_LABEL}`}
              className={cn(
                'wl-press flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-surface-subtle',
                collapsed && 'flex-col justify-center gap-1 px-0',
                focusRingInset,
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-subtle">
                <WorkLiteMark className="size-6" />
              </span>
              <span className={cn('font-mono text-muted-foreground', collapsed ? 'text-[10px] leading-none' : 'min-w-0 flex-1 truncate text-[11px]')}>
                {APP_VERSION_LABEL}
              </span>
            </button>
          </TooltipTrigger>
          {collapsed ? <TooltipContent side="right">{t('reload')}</TooltipContent> : null}
        </Tooltip>
      </div>
    </aside>
  );
}

export { Sidebar };
