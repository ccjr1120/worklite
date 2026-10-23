import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, FileText, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useArtifactListQuery, useWorkflowsQuery } from '@/api/queries';
import { useLocale } from '@/components/locale-provider';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/i18n/format';
import { toSingleLine } from '@/lib/single-line';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function ArtifactListPane({ activeArtifactId }: { activeArtifactId: string | null }) {
  const { t } = useTranslation(['artifacts', 'common']);
  const { locale } = useLocale();
  const workspaceSlug = 'personal';
  const [search, setSearch] = useState('');
  const [workflowId, setWorkflowId] = useState('all');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 250);
  const { data: workflows = [] } = useWorkflowsQuery(workspaceSlug);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, workflowId]);

  const query = useMemo(
    () => ({
      search: debouncedSearch.trim() || undefined,
      workflowId: workflowId === 'all' ? undefined : workflowId,
      page,
      pageSize: PAGE_SIZE,
    }),
    [debouncedSearch, workflowId, page],
  );
  const { data, isError, isFetching, refetch } = useArtifactListQuery(workspaceSlug, query);

  // The server clamps a page past the end (for example after a deletion). Reflect
  // that only once the matching response has arrived, not while old data lingers.
  useEffect(() => {
    if (!isFetching && data && data.page !== page) setPage(data.page);
  }, [data, isFetching, page]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const currentPage = data?.page ?? page;
  const totalPages = data?.totalPages ?? 0;
  const filtered = Boolean(debouncedSearch.trim() || workflowId !== 'all');
  const activeWorkflowName = workflows.find((workflow) => workflow.id === workflowId)?.name;
  const noMatchesDescription = debouncedSearch.trim()
    ? t('noMatches.description', { search: debouncedSearch.trim() })
    : t('list.noWorkflowMatches', { workflow: activeWorkflowName ?? '' });

  return (
    <div className="flex h-full min-h-0 flex-col border-b border-border bg-surface/40 md:border-b-0 md:border-r">
      <div className="shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-brand" aria-hidden="true" />
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t('title')}</h1>
          {data ? <Badge variant="neutral">{t('list.count', { count: total })}</Badge> : null}
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('list.searchPlaceholder')}
            aria-label={t('list.searchPlaceholder')}
            className="h-9 pl-8 text-[13px]"
          />
        </div>
        <Select value={workflowId} onValueChange={setWorkflowId}>
          <SelectTrigger aria-label={t('list.filterWorkflow')} className="mt-2 h-9 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('list.allWorkflows')}</SelectItem>
            {workflows.map((workflow) => (
              <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!data && !isError ? (
          <div role="status" aria-busy="true" aria-live="polite" className="space-y-3 px-4 py-4">
            <span className="sr-only">{t('list.loading')}</span>
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="p-3">
            <ErrorState title={t('list.loadFailed')} description={t('list.loadFailedDescription')} onAction={() => void refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="p-3">
            {filtered ? (
              <EmptyState
                title={t('noMatches.title')}
                description={noMatchesDescription}
                actionLabel={t('common:actions.clearFilters')}
                onAction={() => { setSearch(''); setWorkflowId('all'); }}
                className="px-4 py-8"
              />
            ) : (
              <EmptyState title={t('empty.title')} description={t('empty.description')} className="px-4 py-8" />
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {items.map((item) => {
              const active = item.id === activeArtifactId;
              const summary = toSingleLine(item.summary);
              return (
                <li key={item.id}>
                  <Link
                    to="/artifacts/$artifactId"
                    params={{ artifactId: item.id }}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block border-l-2 px-4 py-3.5 transition-colors duration-[140ms] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/25',
                      active ? 'border-brand bg-brand-subtle/60' : 'border-transparent hover:bg-surface-subtle',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                      <Badge variant={active ? 'brand' : 'neutral'}>{item.type}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{item.workflowName}</p>
                    {summary ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground/90">{summary}</p> : null}
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
                      <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, locale)}</time>
                      <span className="shrink-0">{t('list.length', { count: item.contentLength })}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {totalPages > 1 ? (
        <div className="shrink-0 border-t border-border px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              aria-label={t('list.previous')}
              disabled={currentPage <= 1 || isFetching}
              onClick={() => setPage(Math.max(1, currentPage - 1))}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">{t('list.page', { page: currentPage, pages: totalPages })}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-compact"
              aria-label={t('list.next')}
              disabled={currentPage >= totalPages || isFetching}
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { ArtifactListPane };
