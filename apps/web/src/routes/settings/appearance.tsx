import { createFileRoute } from '@tanstack/react-router';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type AppLocale } from '@/i18n/locale';
import { cn } from '@/lib/utils';
import type { Appearance } from '@/lib/theme';

export const Route = createFileRoute('/settings/appearance')({
  component: AppearanceSettingsPage,
});

function AppearanceSettingsPage() {
  const { t } = useTranslation('settings');
  const { appearance, resolvedTheme, setAppearance } = useTheme();
  const { locale, setLocale } = useLocale();
  const [saveError, setSaveError] = useState('');

  const themeOptions: { value: Appearance; label: string; description: string; icon: typeof Sun }[] = [
    { value: 'system', label: t('appearance.theme.system'), description: t('appearance.theme.systemDescription'), icon: Monitor },
    { value: 'light', label: t('appearance.theme.light'), description: t('appearance.theme.lightDescription'), icon: Sun },
    { value: 'dark', label: t('appearance.theme.dark'), description: t('appearance.theme.darkDescription'), icon: Moon },
  ];

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.appearance') }]} />
      <h1 className="text-2xl font-semibold tracking-tight">{t('appearance.title')}</h1>
      <p className="mt-2 text-[13px] text-muted-foreground">
        {t('appearance.description', { theme: resolvedTheme })}
      </p>

      <h2 className="mt-8 text-base font-semibold">{t('appearance.theme.title')}</h2>
      <RadioGroup className="mt-3 gap-3" value={appearance} onValueChange={(value) => { setSaveError(''); void setAppearance(value as Appearance).catch(() => setSaveError(t('appearance.saveFailed'))); }}>
        {themeOptions.map((option) => {
          const Icon = option.icon;
          const selected = appearance === option.value;
          return (
            <label
              key={option.value}
              htmlFor={`appearance-${option.value}`}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4',
                selected ? 'border-brand bg-brand-subtle' : 'border-border bg-surface',
              )}
            >
              <RadioGroupItem id={`appearance-${option.value}`} value={option.value} className="mt-0.5" />
              <Icon className="mt-0.5 size-4" aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-[13px] text-muted-foreground">{option.description}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>

      <h2 className="mt-8 text-base font-semibold">{t('appearance.language.title')}</h2>
      <p className="mt-2 text-[13px] text-muted-foreground">{t('appearance.language.description')}</p>
      <RadioGroup className="mt-3 gap-3" value={locale} onValueChange={(value) => { setSaveError(''); void setLocale(value as AppLocale).catch(() => setSaveError(t('appearance.saveFailed'))); }}>
        {SUPPORTED_LOCALES.map((value) => {
          const selected = locale === value;
          return (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4',
                selected ? 'border-brand bg-brand-subtle' : 'border-border bg-surface',
              )}
            >
              <RadioGroupItem value={value} className="mt-0.5" />
              <span className="block text-sm font-medium">{LOCALE_NATIVE_NAMES[value]}</span>
            </label>
          );
        })}
      </RadioGroup>
      {saveError ? <p className="mt-4 text-[13px] text-danger" role="alert">{saveError}</p> : null}
    </div>
  );
}
