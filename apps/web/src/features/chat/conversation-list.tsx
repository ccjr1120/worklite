import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatConversationSummary } from '@worklite/contracts';
import { useChatChannelsQuery, useChatConversationsQuery } from '@/api/queries';
import { isLiveStatus, StatusDot, toStatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TruncatedText } from '@/components/ui/truncated-text';
import { focusRingInset } from '@/components/ui/interaction';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { cn } from '@/lib/utils';
import { messagePreview } from './attachment-preview';

type Group = { id: 'today' | 'earlier'; items: ChatConversationSummary[] };

// A running conversation stays in updatedAt order rather than a separate section.
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

export function ConversationList({ selectedId, onSelect, variant = 'switcher' }: { selectedId: string | null; onSelect: (id: string | null) => void; variant?: 'sidebar' | 'switcher' }) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const channels = useChatChannelsQuery();
  const query = useChatConversationsQuery();
  const listRef = useRef<HTMLDivElement>(null);
  const sidebar = variant === 'sidebar';
  useEffect(() => { if (!sidebar) listRef.current?.focus(); }, [sidebar]);
  const items = useMemo(() => [...new Map((query.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
    .slice(0, sidebar ? 20 : undefined), [query.data, sidebar]);
  const groups = useMemo(() => groupConversations(items), [items]);
  const channelName = (id: string) => channels.data?.find((entry) => entry.id === id)?.name ?? id;

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The group delegates arrow-key focus to its native buttons.
    <div ref={listRef} role="group" aria-label={t('history.title')} tabIndex={-1} className="flex h-full min-h-0 w-full flex-col pt-2 outline-none" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3" onScroll={(event) => {
        const list = event.currentTarget;
        if (!sidebar && list.scrollHeight - list.scrollTop - list.clientHeight < 80 && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      }}>
        {sidebar ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-current={selectedId === null ? 'true' : undefined}
            className={cn(
              'wl-press relative mb-0.5 flex w-full rounded-md px-2.5 py-2.5 text-left text-[13px]',
              selectedId === null ? 'bg-brand-subtle font-semibold' : 'font-medium text-foreground/85 hover:bg-surface-subtle',
              focusRingInset,
            )}
          >
            {selectedId === null ? <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand" aria-hidden="true" /> : null}
            <TruncatedText text={t('history.new')} />
          </button>
        ) : null}
        {query.isLoading ? (
          <div className="space-y-1.5 px-1" role="status" aria-label={t('history.loading')}>{[0, 1, 2, 3, 4].map((id) => <Skeleton key={id} className="h-10 w-full rounded-md" />)}</div>
        ) : query.isError && !query.data ? (
          <div className="space-y-2 p-2"><p role="alert" className="text-sm text-danger">{t('history.loadFailed')}</p><Button variant="secondary" size="compact" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div>
        ) : items.length === 0 ? (
          sidebar ? null : (
            <div className="wl-enter px-3 py-8 text-center">
              <p className="text-[13px] text-muted-foreground">{t('history.empty')}</p>
            </div>
          )
        ) : (
          <div className={sidebar ? 'space-y-0.5' : 'space-y-4'} aria-label={t('history.title')}>
            {groups.map((group) => (
              <section key={group.id} aria-labelledby={sidebar ? undefined : `chat-group-${group.id}`}>
                {sidebar ? null : (
                  <h3 id={`chat-group-${group.id}`} className="flex items-center gap-2 px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">
                    <span>{t(`history.groups.${group.id}`)}</span>
                    <span className="tabular-nums opacity-70">{group.items.length}</span>
                  </h3>
                )}
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
                            'wl-press group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left',
                            selected ? 'bg-brand-subtle' : live ? 'bg-brand-subtle/45 hover:bg-brand-subtle/80' : 'hover:bg-surface-subtle',
                            focusRingInset,
                          )}
                        >
                          {selected ? <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-brand" aria-hidden="true" /> : null}
                          {sidebar ? null : <StatusDot status={statusKey} />}
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <TruncatedText text={messagePreview(item.title, (count) => t('attachment.imageSummary', { count })) || t('history.untitled')} className={cn('flex-1 text-[13px]', live || selected ? 'font-semibold' : 'font-medium', !live && !selected && 'text-foreground/85')} />
                            {sidebar ? (statusKey !== 'completed' ? (
                              <span
                                role="img"
                                aria-label={t(`status.${item.status}`)}
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  statusKey === 'running' || statusKey === 'starting' ? 'bg-brand'
                                    : statusKey === 'waiting_for_input' || statusKey === 'paused' ? 'bg-warning'
                                      : statusKey === 'failed' ? 'bg-danger'
                                        : statusKey === 'queued' ? 'bg-info' : 'bg-muted-foreground',
                                )}
                              />
                            ) : null) : (
                              <span className="flex min-w-0 max-w-[55%] shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted-foreground">
                                <TruncatedText text={channelName(item.channel)} className="inline" /><span aria-hidden="true">·</span>
                                <span className={cn('min-w-0 truncate', live && 'font-medium text-brand-text', item.status === 'waiting_for_input' && 'text-warning', item.status === 'failed' && 'text-danger')}>{t(`status.${item.status}`)}</span>
                                <time className="ml-auto shrink-0 whitespace-nowrap tabular-nums" dateTime={item.updatedAt}>{formatDateTime(item.updatedAt, locale)}</time>
                              </span>
                            )}
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
