import { createFileRoute } from '@tanstack/react-router';
import { LoaderCircle, Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/components/theme-provider';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { cn } from '@/lib/utils';
import type { Appearance } from '@/lib/theme';

export const Route = createFileRoute('/settings/appearance')({
  component: AppearanceSettingsPage,
});

function AppearanceSettingsPage() {
  const { t } = useTranslation('settings');
  const { appearance, setAppearance } = useTheme();
  const [saveError, setSaveError] = useState('');
  const [pendingTheme, setPendingTheme] = useState<Appearance | null>(null);

  // Theme applies optimistically. A rejected write restores the previous value.
  async function selectTheme(next: Appearance) {
    if (next === appearance || pendingTheme !== null) return;
    const previous = appearance;
    setSaveError('');
    setPendingTheme(next);
    try {
      await setAppearance(next);
    } catch {
      setSaveError(t('appearance.saveFailed'));
      await setAppearance(previous).catch(() => undefined);
    } finally {
      setPendingTheme(null);
    }
  }

  const themeOptions: { value: Appearance; label: string; description: string; icon: typeof Sun }[] = [
    { value: 'system', label: t('appearance.theme.system'), description: t('appearance.theme.systemDescription'), icon: Monitor },
    { value: 'light', label: t('appearance.theme.light'), description: t('appearance.theme.lightDescription'), icon: Sun },
    { value: 'dark', label: t('appearance.theme.dark'), description: t('appearance.theme.darkDescription'), icon: Moon },
  ];

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: t('nav.title') }, { label: t('nav.appearance') }]} />
      <h1 className="text-2xl font-semibold tracking-tight">{t('appearance.title')}</h1>

      <h2 className="mt-8 text-base font-semibold">{t('appearance.theme.title')}</h2>
      <RadioGroup className="mt-3 gap-3" value={appearance} onValueChange={(value) => void selectTheme(value as Appearance)}>
        {themeOptions.map((option) => {
          const Icon = option.icon;
          const selected = appearance === option.value;
          const pending = pendingTheme === option.value;
          return (
            <label
              key={option.value}
              htmlFor={`appearance-${option.value}`}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors duration-[120ms] ease-out',
                selected ? 'border-brand bg-brand-subtle' : 'border-border bg-surface',
              )}
            >
              <RadioGroupItem id={`appearance-${option.value}`} value={option.value} className="mt-0.5" />
              <Icon className="mt-0.5 size-4" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {option.label}
                  {pending ? <LoaderCircle className="size-3.5 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" /> : null}
                </span>
                <span className="block text-[13px] text-muted-foreground">{option.description}</span>
              </span>
            </label>
          );
        })}
      </RadioGroup>

      {saveError ? <p className="mt-4 text-[13px] text-danger" role="alert">{saveError}</p> : null}
    </div>
  );
}
