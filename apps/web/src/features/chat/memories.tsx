import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { useChatMemoriesQuery, useDeleteChatMemoryMutation } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';

export function Memories() {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const query = useChatMemoriesQuery(true);
  const deletion = useDeleteChatMemoryMutation();
  if (query.isLoading) return <div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-6 md:px-6 md:py-8" role="status" aria-label={t('memories.loading')}><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (query.isError) return <div className="mx-auto w-full max-w-[840px] space-y-3 px-4 py-6 md:px-6 md:py-8"><p role="alert" className="text-sm text-danger">{t('memories.loadFailed')}</p><Button variant="secondary" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div>;
  const items = query.data?.items ?? [];
  return <div className="mx-auto w-full max-w-[840px] space-y-4 px-4 py-6 md:px-6 md:py-8">
    <p className="text-xs text-muted-foreground">{t('memories.hint')}</p>
    {items.length === 0 ? <p className="text-sm text-muted-foreground">{t('memories.empty')}</p> : (
      <ul className="space-y-3">
        {items.map((memory) => (
          <li key={memory.id} className="rounded-md border border-border p-3">
            <p className="whitespace-pre-wrap break-all text-sm leading-6">{memory.content}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <time className="text-xs tabular-nums text-muted-foreground" dateTime={memory.updatedAt}>{formatDateTime(memory.updatedAt, locale)}</time>
              <Button variant="ghost" size="compact" disabled={deletion.isPending} onClick={() => deletion.mutate(memory.id)}><Trash2 className="size-3.5" />{t('memories.delete')}</Button>
            </div>
          </li>
        ))}
      </ul>
    )}
    {deletion.isError ? <p role="alert" className="text-[13px] text-danger">{t('memories.deleteFailed')}</p> : null}
  </div>;
}
