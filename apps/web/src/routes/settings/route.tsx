import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useTranslation('settings');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = [
    { id: 'usage', label: t('nav.usage'), to: '/settings/usage' },
    { id: 'audit-log', label: t('nav.auditLog'), to: '/settings/audit-log' },
    { id: 'logs', label: t('nav.logs'), to: '/settings/logs' },
    { id: 'appearance', label: t('nav.appearance'), to: '/settings/appearance' },
  ] as const;

  return (
    <div className="flex min-h-full">
      <nav className="w-full border-b border-border p-3 md:w-52 md:shrink-0 md:border-b-0 md:border-r md:p-4">
        <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">{t('nav.title')}</p>
        <ul className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
          {items.map((item) => {
            const active = pathname.endsWith(`/settings/${item.id}`);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  params={{}}
                  className={cn(
                    'block whitespace-nowrap rounded-md px-2 py-1.5 text-[13px]',
                    active ? 'bg-brand-subtle font-medium text-foreground' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
