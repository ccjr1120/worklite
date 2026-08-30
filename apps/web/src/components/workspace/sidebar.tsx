import { Link, useRouterState } from '@tanstack/react-router';
import { Blocks, Bot, ChevronDown, Home, KeyRound, Puzzle, Server, Settings, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { focusRingInset } from '@/components/ui/interaction';
import { UserMenu } from '@/components/workspace/user-menu';
import { WorkLiteMark } from '@/components/worklite-mark';
import { cn } from '@/lib/utils';

const agentResources = [
  { id: 'skills', labelKey: 'nav.skills', to: '/skills', icon: Blocks },
  { id: 'mcp-servers', labelKey: 'nav.mcpServers', to: '/mcp-servers', icon: Server },
  { id: 'providers', labelKey: 'nav.modelProviders', to: '/model-providers', icon: KeyRound },
] as const;

const primaryItems = [
  { id: 'home', labelKey: 'nav.home', to: '/home', icon: Home },
  { id: 'plugins', labelKey: 'nav.plugins', to: '/plugins', icon: Puzzle },
  { id: 'workflows', labelKey: 'nav.workflows', to: '/workflows', icon: Workflow },
  { id: 'settings', labelKey: 'nav.settings', to: '/settings/appearance', icon: Settings },
] as const;

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation('workspace');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const agentPageActive = pathname.startsWith('/agents');
  const agentResourceActive = agentResources.some((item) => pathname.startsWith(item.to));
  const agentGroupActive = agentPageActive || agentResourceActive;
  const [agentsExpanded, setAgentsExpanded] = useState(agentGroupActive || !collapsed);

  useEffect(() => {
    if (agentGroupActive) setAgentsExpanded(true);
  }, [agentGroupActive]);

  function primaryActive(id: (typeof primaryItems)[number]['id'], to: string) {
    if (id === 'settings') return pathname.startsWith('/settings');
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  function primaryLink(item: (typeof primaryItems)[number]) {
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
        <ul className="flex flex-col gap-0.5">
          <li>{primaryLink(primaryItems[0])}</li>
          <li>
            {collapsed ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={cn('relative flex h-8 w-full items-center justify-center rounded-md text-muted-foreground transition-colors duration-[120ms] hover:bg-surface-subtle hover:text-foreground', agentGroupActive && 'bg-brand-subtle font-medium text-foreground', focusRingInset)} aria-label={t('nav.agents')}>
                    {agentGroupActive ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-brand" aria-hidden="true" /> : null}
                    <Bot className="size-[18px]" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start">
                  <DropdownMenuLabel>{t('nav.agentResources')}</DropdownMenuLabel>
                  <DropdownMenuItem asChild><Link to="/agents" onClick={onNavigate}><Bot className="size-4" />{t('nav.agents')}</Link></DropdownMenuItem>
                  {agentResources.map((item) => <DropdownMenuItem key={item.id} asChild><Link to={item.to} onClick={onNavigate}><item.icon className="size-4" />{t(item.labelKey)}</Link></DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div>
                <div className="relative flex items-center">
                  <Link to="/agents" onClick={onNavigate} className={cn('relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 pr-9 text-[13px] transition-colors duration-[120ms]', agentPageActive ? 'bg-brand-subtle font-medium text-foreground' : agentGroupActive ? 'font-medium text-foreground hover:bg-surface-subtle' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground', focusRingInset)} aria-current={agentPageActive ? 'page' : undefined}>
                    {agentPageActive ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-brand" aria-hidden="true" /> : null}
                    <Bot className="size-[18px] shrink-0" aria-hidden="true" />
                    <span className="truncate">{t('nav.agents')}</span>
                  </Link>
                  <button type="button" className={cn('absolute right-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground', focusRingInset)} onClick={() => setAgentsExpanded((value) => !value)} aria-label={agentsExpanded ? t('nav.collapseAgentResources') : t('nav.expandAgentResources')} aria-expanded={agentsExpanded}>
                    <ChevronDown className={cn('size-4 transition-transform duration-[150ms]', !agentsExpanded && '-rotate-90')} aria-hidden="true" />
                  </button>
                </div>
                {agentsExpanded ? (
                  <ul className="ml-[17px] mt-0.5 space-y-0.5 border-l border-border pl-2">
                    {agentResources.map((item) => {
                      const active = pathname.startsWith(item.to);
                      return <li key={item.id}><Link to={item.to} onClick={onNavigate} className={cn('flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-surface-subtle hover:text-foreground', active && 'bg-brand-subtle font-medium text-foreground', focusRingInset)} aria-current={active ? 'page' : undefined}><item.icon className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{t(item.labelKey)}</span></Link></li>;
                    })}
                  </ul>
                ) : null}
              </div>
            )}
          </li>
          {primaryItems.slice(1).map((item) => <li key={item.id}>{primaryLink(item)}</li>)}
        </ul>
      </nav>
      <div className="border-t border-border p-2"><UserMenu collapsed={collapsed} /></div>
    </aside>
  );
}

export { Sidebar };
