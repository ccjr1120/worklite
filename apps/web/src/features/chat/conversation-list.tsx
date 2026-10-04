import { useDeferredValue, useState } from 'react';
import { LoaderCircle, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatChannelsQuery, useChatConversationsQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { focusRingInset } from '@/components/ui/interaction';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { cn } from '@/lib/utils';

export function ConversationList({ selectedId, onSelect, onNew }: { selectedId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('all');
  const channels = useChatChannelsQuery();
  const query = useChatConversationsQuery(useDeferredValue(search), channel === 'all' ? '' : channel);
  const items = [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values()];
  const filtered = Boolean(search || channel !== 'all');
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="space-y-3 border-b border-border p-3">
        <Button variant="secondary" className="w-full" onClick={onNew}><Plus className="size-4" />{t('history.new')}</Button>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('history.searchPlaceholder')} aria-label={t('history.searchPlaceholder')} />
        <Select value={channel} onValueChange={setChannel}><SelectTrigger aria-label={t('history.channel')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('history.allChannels')}</SelectItem>{channels.data?.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {query.isLoading ? <div className="space-y-2" role="status" aria-label={t('history.loading')}>{[0, 1, 2, 3].map((id) => <Skeleton key={id} className="h-16 w-full" />)}</div> : query.isError && !query.data ? <div className="space-y-2 p-2"><p role="alert" className="text-sm text-danger">{t('history.loadFailed')}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div> : items.length === 0 ? <div className="space-y-2 px-2 py-5"><p className="text-sm text-muted-foreground">{t(filtered ? 'history.noMatch' : 'history.empty')}</p>{filtered ? <Button variant="ghost" size="compact" onClick={() => { setSearch(''); setChannel('all'); }}>{t('history.clear')}</Button> : null}</div> : (
          <ul className="space-y-1" aria-label={t('history.title')}>
            {items.map((item) => <li key={item.id}><button type="button" onClick={() => onSelect(item.id)} aria-current={selectedId === item.id ? 'true' : undefined} className={cn('w-full rounded-md p-2.5 text-left hover:bg-surface-subtle', focusRingInset, selectedId === item.id && 'bg-brand-subtle')}><span className="block truncate text-[13px] font-medium">{item.title || t('history.untitled')}</span><span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>{channels.data?.find((entry) => entry.id === item.channel)?.name ?? item.channel} · {t(`status.${item.status}`)}</span><time dateTime={item.updatedAt}>{formatDateTime(item.updatedAt, locale)}</time></span></button></li>)}
          </ul>
        )}
        {query.hasNextPage ? <Button className="mt-3 w-full" variant="ghost" size="compact" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? <LoaderCircle className="size-4 motion-safe:animate-spin" /> : null}{t('history.more')}</Button> : null}
        {query.isError && query.data ? <div className="space-y-2 p-2"><p role="alert" className="text-[13px] text-danger">{t('history.loadFailed')}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div> : null}
        {query.isFetchNextPageError && !query.isError ? <p role="alert" className="p-2 text-[13px] text-danger">{t('history.loadFailed')}</p> : null}
      </div>
    </div>
  );
}
