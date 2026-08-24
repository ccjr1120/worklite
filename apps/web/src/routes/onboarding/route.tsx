import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { RequireSession } from '@/components/require-session';
import { WorkLiteMark } from '@/components/worklite-mark';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/onboarding')({
  component: OnboardingLayout,
});

function OnboardingLayout() {
  const { t } = useTranslation(['onboarding', 'common']);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const steps = [
    { id: 'team', label: t('steps.team'), to: '/onboarding/team' },
    { id: 'provider', label: t('steps.provider'), to: '/onboarding/provider' },
    { id: 'first-agent', label: t('steps.firstAgent'), to: '/onboarding/first-agent' },
  ] as const;

  return (
    <RequireSession>
      <div className="min-h-screen bg-background px-5 py-10">
        <div className="mx-auto w-full max-w-[560px]">
          <div className="mb-8 flex items-center gap-2">
            <WorkLiteMark />
            <span className="text-sm font-semibold">{t('common:brand.name')}</span>
          </div>
          <ol className="mb-8 flex gap-4">
            {steps.map((step, index) => {
              const active = pathname.endsWith(step.id);
              return (
                <li key={step.id} className="flex items-center gap-2 text-[13px]">
                  <span
                    className={cn(
                      'inline-flex size-5 items-center justify-center rounded-full text-[11px] font-medium',
                      active ? 'bg-brand text-brand-foreground' : 'bg-surface-subtle text-muted-foreground',
                    )}
                  >
                    {index + 1}
                  </span>
                  <Link to={step.to} className={cn(active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {step.label}
                  </Link>
                </li>
              );
            })}
          </ol>
          <Outlet />
        </div>
      </div>
    </RequireSession>
  );
}
