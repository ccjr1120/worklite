import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/password-input';
import { StatusBadge } from '@/components/status-badge';
import { AgentResourceNav } from '@/components/agent-resource-nav';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatList } from '@/i18n/format';
import { modelProviders } from '@/mock/data';

export const Route = createFileRoute('/$teamSlug/model-providers')({
  component: ModelProvidersPage,
});

function ModelProvidersPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { locale } = useLocale();
  const { teamSlug } = Route.useParams();
  const [testing, setTesting] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('providers.title') }]} />
      <h1 className="text-2xl font-semibold tracking-tight">{t('providers.title')}</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('providers.description')}</p>
      <AgentResourceNav teamSlug={teamSlug} active="providers" />
      <div className="mt-6 flex max-w-[840px] flex-col gap-4">
        {modelProviders.map((provider) => (
          <section key={provider.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{provider.name}</h2>
              <StatusBadge status={provider.status === 'connected' ? 'connected' : 'unconfigured'} />
            </div>
            <p className="mt-2 font-mono text-[13px] text-muted-foreground">{provider.maskedKey}</p>
            <p className="mt-1 text-[13px] text-muted-foreground">{formatList(provider.models, locale)}</p>
            <Field className="mt-4" label={t('providers.replaceKey')} htmlFor={`${provider.id}-key`}>
              <PasswordInput id={`${provider.id}-key`} autoComplete="off" placeholder={t('providers.secretPlaceholder')} />
            </Field>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                size="compact"
                onClick={() => {
                  setTesting(provider.id);
                  window.setTimeout(() => {
                    setTesting(null);
                    toast.success(t('providers.testSucceeded', { provider: provider.name }));
                  }, 500);
                }}
              >
                {testing === provider.id ? t('providers.testing') : t('providers.test')}
              </Button>
              <Button size="compact" onClick={() => toast.success(t('providers.saved'))}>
                {t('common:actions.save')}
              </Button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
