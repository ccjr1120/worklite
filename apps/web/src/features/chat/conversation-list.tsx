import { useMemo } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatConversationSummary } from '@worklite/contracts';
import { useChatChannelsQuery, useChatConversationsQuery } from '@/api/queries';
import { isLiveStatus, StatusDot, toStatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { focusRingInset } from '@/components/ui/interaction';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { cn } from '@/lib/utils';

type Group = { id: 'today' | 'earlier'; items: ChatConversationSummary[] };

// Items already arrive sorted by updatedAt (desc) from the API; a running conversation
// is found by position in that order and its live status dot, not a separate section.
function groupConversations(items: ChatConversationSummary[]): Group[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today: ChatConversationSummary[] = [];
  const earlier: ChatConversationSummary[] = [];
  for (const item of items) {
    if (new Date(item.updatedAt) >= startOfToday) today.push(item);
    else earlier.push(item);
  }
  return ([{ id: 'today', items: today }, { id: 'earlier', items: earlier }] satisfies Group[]).filter((group) => group.items.length > 0);
}

function rowStatusKey(status: ChatConversationSummary['status']) {
  return status === 'task' ? 'idle' : toStatusKey(status);
}

export function ConversationList({ selectedId, onSelect, onNew }: { selectedId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const channels = useChatChannelsQuery();
  const query = useChatConversationsQuery();
  const items = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values()], [query.data]);
  const groups = useMemo(() => groupConversations(items), [items]);
  const channelName = (id: string) => channels.data?.find((entry) => entry.id === id)?.name ?? id;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="p-3">
        <Button variant="secondary" className="w-full justify-start" onClick={onNew}><MessageSquarePlus className="size-4" />{t('history.new')}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {query.isLoading ? (
          <div className="space-y-1.5 px-1" role="status" aria-label={t('history.loading')}>{[0, 1, 2, 3, 4].map((id) => <Skeleton key={id} className="h-[58px] w-full rounded-md" />)}</div>
        ) : query.isError && !query.data ? (
          <div className="space-y-2 p-2"><p role="alert" className="text-sm text-danger">{t('history.loadFailed')}</p><Button variant="secondary" size="compact" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div>
        ) : items.length === 0 ? (
          <div className="wl-enter px-3 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">{t('history.empty')}</p>
          </div>
        ) : (
          <div className="space-y-4" aria-label={t('history.title')}>
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={`chat-group-${group.id}`}>
                <h3 id={`chat-group-${group.id}`} className="flex items-center gap-2 px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
                  <span>{t(`history.groups.${group.id}`)}</span>
                  <span className="tabular-nums opacity-70">{group.items.length}</span>
                </h3>
                <ul className="wl-stagger space-y-0.5">
                  {group.items.map((item) => {
                    const selected = selectedId === item.id;
                    const live = isLiveStatus(item.status);
                    const statusKey = rowStatusKey(item.status);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(item.id)}
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'wl-press group relative flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 text-left',
                            selected ? 'bg-brand-subtle' : live ? 'bg-brand-subtle/45 hover:bg-brand-subtle/80' : 'hover:bg-surface-subtle',
                            focusRingInset,
                          )}
                        >
                          {selected ? <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand" aria-hidden="true" /> : null}
                          <StatusDot status={statusKey} className="mt-0.5" />
                          <span className="min-w-0 flex-1">
                            <span className={cn('block truncate text-[13px]', live || selected ? 'font-semibold' : 'font-medium', !live && !selected && 'text-foreground/85')}>{item.title || t('history.untitled')}</span>
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span className="truncate">{channelName(item.channel)}</span>
                              <span aria-hidden="true">·</span>
                              <span className={cn('shrink-0', live && 'font-medium text-brand-text', item.status === 'waiting_for_input' && 'text-warning', item.status === 'failed' && 'text-danger')}>{t(`status.${item.status}`)}</span>
                              <time className="ml-auto shrink-0 tabular-nums" dateTime={item.updatedAt}>{formatDateTime(item.updatedAt, locale)}</time>
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        {query.isError && query.data ? <div className="space-y-2 p-2"><p role="alert" className="text-[13px] text-danger">{t('history.loadFailed')}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div> : null}
      </div>
    </div>
  );
}
