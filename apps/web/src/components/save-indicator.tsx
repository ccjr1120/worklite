import { Check, CloudOff, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type SaveState = 'saved' | 'saving' | 'unsaved';

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation('common');
  const config = {
    saved: { label: t('saveState.saved'), icon: Check },
    saving: { label: t('saveState.saving'), icon: LoaderCircle },
    unsaved: { label: t('saveState.unsaved'), icon: CloudOff },
  }[state];
  const Icon = config.icon;

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px] text-muted-foreground')}>
      <Icon className={cn('size-3.5', state === 'saving' && 'motion-safe:animate-spin')} aria-hidden="true" />
      {config.label}
    </span>
  );
}

export { SaveIndicator };
