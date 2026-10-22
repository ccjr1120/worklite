import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useAgentTeamRecordsQuery, useAgentTeamsQuery } from '@/api/queries';
import { ErrorState } from '@/components/error-state';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { TeamSwitcher } from './team-switcher';
import { runModeLabel } from './run-mode';

export function TeamRecords({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const query = useAgentTeamRecordsQuery(teamId);
  const teamName = useAgentTeamsQuery().data?.find((team) => team.id === teamId)?.name;
  const crumbs = [{ label: t('title') }, ...(teamName ? [{ label: teamName }] : [])];

  if (query.isPending) return <PageContainer width="detail"><WorkspaceChrome crumbs={crumbs} /><div className="space-y-3" role="status"><Skeleton className="h-8 w-72" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div></PageContainer>;
  if (query.isError) return <PageContainer width="detail"><WorkspaceChrome crumbs={crumbs} /><TeamSwitcher teamId={teamId} view="records" /><ErrorState title={t('records.title')} description={t('records.loadFailed')} onAction={() => void query.refetch()} /></PageContainer>;

  return (
    <PageContainer width="detail">
      <WorkspaceChrome crumbs={crumbs} />
      <PageHeading title={teamName ?? t('title')} description={t('records.description')} actions={<div className="flex items-center gap-2"><Link to="/agent-teams/$teamId/config" params={{ teamId }} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">{t('config.viewConfig')}</Link><Link to="/chat" className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground hover:opacity-90">{t('records.openChat')}</Link></div>} />
      <TeamSwitcher teamId={teamId} view="records" />
      {!query.data.length ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"><p>{t('records.empty')}</p><Link to="/chat" className="mt-2 inline-block text-brand-text underline underline-offset-4">{t('records.openChat')}</Link></div>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {query.data.map((run) => (
            <li key={run.id}>
              <Link to="/agent-team-runs/$runId" params={{ runId: run.id }} className="block space-y-2 rounded-lg px-4 py-4 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex flex-wrap items-center gap-3"><StatusBadge status={toStatusKey(run.status)} label={t(`run.status.${run.status}`)} /><span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{run.intent}</span>{teamName ? <span className="shrink-0 rounded-full bg-surface-subtle px-2 py-0.5 text-xs text-muted-foreground">{teamName}</span> : null}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span className="font-mono break-all">{run.projectDirectory}</span><span title={run.modeRationale ?? undefined}>{runModeLabel(t, run.mode, run.orchestrationVersion, run.modeDecidedAt)}</span><span>{formatDateTime(run.createdAt, locale)}</span>{run.finishedAt ? <span>{t('records.finishedAt')}: {formatDateTime(run.finishedAt, locale)}</span> : null}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
