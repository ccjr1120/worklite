import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ErrorStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

function ErrorState({ title, description, actionLabel, onAction, className }: ErrorStateProps) {
  const { t } = useTranslation('common');
  const label = actionLabel ?? t('actions.tryAgain');

  return (
    <div role="alert" className={cn('wl-enter flex items-start gap-3 rounded-xl border border-danger/25 bg-danger-subtle px-5 py-4', className)}>
      <AlertCircle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-sm font-semibold text-danger">{title}</h2>
        <p className="text-[13px] leading-5 text-foreground">{description}</p>
        {onAction ? (
          <Button variant="secondary" size="compact" className="mt-2" onClick={onAction}>
            {label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export { ErrorState };
