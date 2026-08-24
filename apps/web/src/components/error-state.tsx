import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

type ErrorStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
};

function ErrorState({ title, description, actionLabel, onAction }: ErrorStateProps) {
  const { t } = useTranslation('common');
  const label = actionLabel ?? t('actions.tryAgain');

  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle px-6 py-6">
      <div className="flex items-center gap-2 text-danger">
        <AlertCircle className="size-4" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <p className="text-[13px] text-foreground">{description}</p>
      {onAction ? (
        <Button variant="secondary" onClick={onAction}>
          {label}
        </Button>
      ) : null}
    </div>
  );
}

export { ErrorState };
