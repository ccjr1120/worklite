import { Link, useRouterState } from '@tanstack/react-router';
import { Bot, Home, Settings, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UserMenu } from '@/components/workspace/user-menu';
import { WorkLiteMark } from '@/components/worklite-mark';
import { cn } from '@/lib/utils';

type PersonalPath = '/home' | '/agents' | '/workflows' | '/settings/appearance';

type NavItem = {
  id: 'home' | 'agents' | 'workflows' | 'settings';
  label: string;
  to: PersonalPath;
  icon: typeof Home;
};

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation('workspace');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items: NavItem[] = [
    { id: 'home', label: t('nav.home'), to: '/home', icon: Home },
    { id: 'agents', label: t('nav.agents'), to: '/agents', icon: Bot },
    { id: 'workflows', label: t('nav.workflows'), to: '/workflows', icon: Workflow },
    { id: 'settings', label: t('nav.settings'), to: '/settings/appearance', icon: Settings },
  ];

  function isActive(item: NavItem) {
    if (item.id === 'agents') {
      return ['/agents', '/skills', '/mcp-servers', '/plugins', '/model-providers'].some((suffix) => pathname.startsWith(suffix));
    }
    if (item.id === 'settings') {
      return pathname.startsWith('/settings');
    }
    const suffix = String(item.to);
    return pathname === suffix || pathname.startsWith(`${suffix}/`);
  }

  return (
    <aside className={cn('flex h-full flex-col border-r border-border bg-surface', collapsed ? 'w-14' : 'w-[232px]')}>
      <div className={cn('flex h-[52px] items-center border-b border-border px-2', collapsed && 'justify-center')}>
        <Link to="/home" aria-label="WorkLite" className="flex items-center gap-2">
          <WorkLiteMark className={collapsed ? 'size-5' : 'size-6'} />
          {collapsed ? null : <span className="text-sm font-semibold">WorkLite</span>}
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const active = isActive(item);
            const content = (
              <Link
                to={item.to}
                onClick={onNavigate}
                className={cn(
                  'relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-[120ms]',
                  collapsed && 'justify-center px-0',
                  active
                    ? 'bg-brand-subtle font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
                )}
                aria-current={active ? 'page' : undefined}
              >
                {active ? <span className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-brand" aria-hidden="true" /> : null}
                <item.icon className="size-[18px] shrink-0" aria-hidden="true" />
                {collapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
              </Link>
            );
            return (
              <li key={item.id}>
                {collapsed ? <Tooltip><TooltipTrigger asChild>{content}</TooltipTrigger><TooltipContent side="right">{item.label}</TooltipContent></Tooltip> : content}
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-border p-2">
        <UserMenu collapsed={collapsed} />
      </div>
    </aside>
  );
}

export { Sidebar };
