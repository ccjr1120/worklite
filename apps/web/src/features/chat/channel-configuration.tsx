import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatChannelsQuery } from '@/api/queries';
import { PluginConfiguration } from '@/features/plugins/plugin-configuration';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { focusRingInset } from '@/components/ui/interaction';
import { cn } from '@/lib/utils';

export function ChannelConfiguration() {
  const { t } = useTranslation('assistant');
  const query = useChatChannelsQuery();
  const [selected, setSelected] = useState('feishu');
  return <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
    {query.isLoading ? <Skeleton className="h-32 w-full" /> : query.isError ? <div className="space-y-2"><p className="text-sm text-danger" role="alert">{t('channels.loadFailed')}</p><Button variant="secondary" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div> : <>
      <div className="flex flex-wrap gap-2" aria-label={t('settings.channels')}>{query.data?.filter((channel) => channel.id !== 'web').map((channel) => <button key={channel.id} type="button" aria-pressed={selected === channel.id} onClick={() => setSelected(channel.id)} className={cn('rounded-md px-3 py-2 text-sm hover:bg-surface-subtle', focusRingInset, selected === channel.id && 'bg-brand-subtle font-medium')}>{channel.name}</button>)}</div>
      {selected === 'feishu' ? <PluginConfiguration pluginId="feishu-bot" embedded /> : null}
    </>}
  </div>;
}
