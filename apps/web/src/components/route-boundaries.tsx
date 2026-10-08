import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';

function RoutePending() {
  const { t } = useTranslation('workspace');

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t('route.loading')}</span>
      <Skeleton className="h-8 w-52" />
      <Skeleton className="mt-3 h-4 w-full max-w-md" />
      <div className="mt-6 space-y-2">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function RouteError({ reset }: { reset?: () => void }) {
  const { t } = useTranslation('workspace');
  const router = useRouter();

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <ErrorState
        title={t('route.errorTitle')}
        description={t('route.errorDescription')}
        onAction={() => {
          reset?.();
          void router.invalidate();
        }}
      />
    </div>
  );
}

export { RoutePending, RouteError };
