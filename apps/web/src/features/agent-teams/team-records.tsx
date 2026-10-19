import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { agentTeamGroupsQueryKey, useAgentTeamGroupsQuery } from '@/api/queries';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { queryClient } from '@/lib/query-client';

export function TeamRecords({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const navigate = useNavigate();
  const query = useAgentTeamGroupsQuery(teamId);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  async function createGroup() {
    if (creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const group = await api.createAgentTeamGroup(teamId, {});
      await queryClient.invalidateQueries({ queryKey: agentTeamGroupsQueryKey(teamId) });
      await navigate({ to: '/agent-team-groups/$groupId', params: { groupId: group.id } });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t('records.createFailed'));
    } finally {
      setCreating(false);
    }
  }

  if (query.isPending) return <div className="space-y-3 py-4" role="status"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (query.isError) return <ErrorState title={t('records.loadFailed')} onAction={() => void query.refetch()} />;
  return (
    <section className="mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('records.title')}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('records.description')}</p>
        </div>
        <Button type="button" size="compact" onClick={() => void createGroup()} disabled={creating}>
          {creating ? t('records.creating') : t('records.create')}
        </Button>
      </div>
      {createError ? <p className="mb-3 text-[13px] text-danger" role="alert">{createError}</p> : null}
      {!query.data.length ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          <p>{t('records.empty')}</p>
          <Link to="/chat" search={{ view: 'conversation' }} className="mt-2 inline-block text-brand-text underline underline-offset-4">{t('records.startInChat')}</Link>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {query.data.map((group) => (
            <li key={group.id}>
              <Link to="/agent-team-groups/$groupId" params={{ groupId: group.id }} className="block space-y-2 rounded-lg px-3 py-4 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{group.title || t('group.untitled')}</span>
                  {group.status === 'empty' ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('group.status.empty')}</span> : <StatusBadge status={toStatusKey(group.status)} label={t(`run.status.${group.status}`)} />}
                </div>
                <p className="line-clamp-2 text-[13px] text-muted-foreground">{group.lastMessage?.body ?? t('group.noMessages')}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{group.repositories.map((repository) => repository.name).join(' · ') || t('group.noRepositories')}</span>
                  <span>{t('group.runCount', { count: group.runCount })}</span>
                  <span>{formatDateTime(group.updatedAt, locale)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
