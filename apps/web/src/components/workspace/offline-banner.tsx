import { WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

function OfflineBanner() {
  const { t } = useTranslation('workspace');
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (!offline) {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning-subtle px-4 py-1.5 text-[13px] text-foreground">
      <WifiOff className="size-3.5" aria-hidden="true" />
      {t('offline.message')}
    </div>
  );
}

export { OfflineBanner };
