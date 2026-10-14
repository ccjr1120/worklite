import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useAgentTeamRecordsQuery } from '@/api/queries';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';

export function TeamRecords({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const query = useAgentTeamRecordsQuery(teamId);
  if (query.isPending) return <div className="space-y-3 py-4" role="status"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (query.isError) return <ErrorState title={t('records.loadFailed')} onAction={() => void query.refetch()} />;
  if (!query.data.length) return <div className="space-y-2 py-8 text-sm"><p className="text-muted-foreground">{t('records.empty')}</p><Link to="/chat" search={{ view: 'conversation' }} className="text-brand-text underline underline-offset-4">{t('records.startInChat')}</Link></div>;
  return <ul className="divide-y divide-border">
    {query.data.map((run) => <li key={run.id}>
      <Link to="/agent-team-runs/$runId" params={{ runId: run.id }} className="block space-y-2 rounded-lg px-3 py-4 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex flex-wrap items-center gap-3"><span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium">{run.intent}</span><StatusBadge status={toStatusKey(run.status)} label={t(`run.status.${run.status}`)} /></div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span className="break-all font-mono">{run.projectDirectory}</span><span>{t(`run.modeValue.${run.mode}`)}</span><span>{t('records.startedAt')} · {formatDateTime(run.createdAt, locale)}</span>{run.finishedAt ? <span>{t('records.finishedAt')} · {formatDateTime(run.finishedAt, locale)}</span> : null}</div>
      </Link>
    </li>)}
  </ul>;
}
