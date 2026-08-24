import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/$teamSlug/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { t } = useTranslation('settings');
  const { teamSlug } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const items = [
    { id: 'general', label: t('nav.general'), to: '/$teamSlug/settings/general' },
    { id: 'members', label: t('nav.members'), to: '/$teamSlug/settings/members' },
    { id: 'usage', label: t('nav.usage'), to: '/$teamSlug/settings/usage' },
    { id: 'audit-log', label: t('nav.auditLog'), to: '/$teamSlug/settings/audit-log' },
    { id: 'appearance', label: t('nav.appearance'), to: '/$teamSlug/settings/appearance' },
  ] as const;

  return (
    <div className="flex min-h-full">
      <nav className="hidden w-52 shrink-0 border-r border-border p-4 md:block">
        <p className="mb-2 px-2 text-xs font-medium text-muted-foreground">{t('nav.title')}</p>
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active = pathname.endsWith(`/settings/${item.id}`);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  params={{ teamSlug }}
                  className={cn(
                    'block rounded-md px-2 py-1.5 text-[13px]',
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
