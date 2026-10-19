import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { CHAT_MEMORY_CATEGORIES, CHAT_MEMORY_CATEGORY_META, type ChatMemoryCategory, type ChatMemoryView } from '@worklite/contracts';
import { useChatMemoriesQuery, useDeleteChatMemoryMutation, useUpdateChatMemoryMutation } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';

const ALL_CATEGORIES = 'all' as const;

export function Memories() {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const query = useChatMemoriesQuery(true);
  const deletion = useDeleteChatMemoryMutation();
  const update = useUpdateChatMemoryMutation();
  const [filter, setFilter] = useState<ChatMemoryCategory | typeof ALL_CATEGORIES>(ALL_CATEGORIES);
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const presentCategories = useMemo(() => CHAT_MEMORY_CATEGORIES.filter((category) => items.some((memory) => memory.category === category)), [items]);
  const groups = useMemo(() => {
    const visible = filter === ALL_CATEGORIES ? items : items.filter((memory) => memory.category === filter);
    return CHAT_MEMORY_CATEGORIES
      .map((category) => ({ category, entries: visible.filter((memory) => memory.category === category) }))
      .filter((group) => group.entries.length > 0);
  }, [filter, items]);
  if (query.isLoading) return <div className="mx-auto w-full max-w-[840px] space-y-5 px-4 py-6 md:px-6 md:py-8" role="status" aria-label={t('memories.loading')}><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (query.isError) return <div className="mx-auto w-full max-w-[840px] space-y-3 px-4 py-6 md:px-6 md:py-8"><p role="alert" className="text-sm text-danger">{t('memories.loadFailed')}</p><Button variant="secondary" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div>;
  return <div className="mx-auto w-full max-w-[840px] space-y-4 px-4 py-6 md:px-6 md:py-8">
    <p className="text-xs text-muted-foreground">{t('memories.hint')}</p>
    {items.length === 0 ? <p className="text-sm text-muted-foreground">{t('memories.empty')}</p> : (
      <>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('memories.filterLabel')}>
          {[ALL_CATEGORIES, ...presentCategories].map((category) => (
            <button key={category} type="button" aria-pressed={filter === category} onClick={() => setFilter(category)} className={cn('rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors', filter === category && 'bg-brand-subtle font-medium text-brand-text')}>
              {category === ALL_CATEGORIES ? t('memories.filterAll') : t(`memories.categories.${category}`)}
            </button>
          ))}
        </div>
        {groups.map((group) => (
          <section key={group.category} className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {t(`memories.categories.${group.category}`)}
              <Badge variant={CHAT_MEMORY_CATEGORY_META[group.category].injection === 'always' ? 'brand' : 'neutral'}>{CHAT_MEMORY_CATEGORY_META[group.category].injection === 'always' ? t('memories.injection.always') : t('memories.injection.onDemand')}</Badge>
            </h3>
            <ul className="space-y-3">
              {group.entries.map((memory) => <MemoryEntry key={memory.id} memory={memory} locale={locale} deleting={deletion.isPending} updating={update.isPending} onDelete={() => deletion.mutate(memory.id)} onCategoryChange={(category) => update.mutate({ memoryId: memory.id, input: { category } })} />)}
            </ul>
          </section>
        ))}
      </>
    )}
    {deletion.isError ? <p role="alert" className="text-[13px] text-danger">{t('memories.deleteFailed')}</p> : null}
    {update.isError ? <p role="alert" className="text-[13px] text-danger">{t('memories.updateFailed')}</p> : null}
  </div>;
}

function MemoryEntry({ memory, locale, deleting, updating, onDelete, onCategoryChange }: { memory: ChatMemoryView; locale: AppLocale; deleting: boolean; updating: boolean; onDelete: () => void; onCategoryChange: (category: ChatMemoryCategory) => void }) {
  const { t } = useTranslation('assistant');
  return (
    <li className="rounded-md border border-border p-3">
      <p className="whitespace-pre-wrap break-all text-sm leading-6">{memory.content}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <time className="text-xs tabular-nums text-muted-foreground" dateTime={memory.updatedAt}>{formatDateTime(memory.updatedAt, locale)}</time>
        <div className="flex items-center gap-1">
          <Select value={memory.category} onValueChange={(value) => onCategoryChange(value as ChatMemoryCategory)} disabled={updating}>
            <SelectTrigger className="h-7 w-auto gap-1 border-none px-2 text-xs text-muted-foreground shadow-none" aria-label={t('memories.changeCategory')}><SelectValue /></SelectTrigger>
            <SelectContent>{CHAT_MEMORY_CATEGORIES.map((category) => <SelectItem key={category} value={category}>{t(`memories.categories.${category}`)}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="compact" disabled={deleting} onClick={onDelete}><Trash2 className="size-3.5" />{t('memories.delete')}</Button>
        </div>
      </div>
    </li>
  );
}
