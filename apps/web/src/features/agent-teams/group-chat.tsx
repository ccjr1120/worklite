import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { agentTeamGroupQueryKey, useAgentTeamGroupQuery } from '@/api/queries';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { MessageResponse } from '@/components/ai-elements/message';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';

export function AgentTeamGroupChatPage({ groupId }: { groupId: string }) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const groupQuery = useAgentTeamGroupQuery(groupId);

  useEffect(() => {
    if (!groupId) return;
    const events = new EventSource(api.agentTeamGroupEventsUrl(groupId), { withCredentials: true });
    events.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: agentTeamGroupQueryKey(groupId) });
    };
    return () => events.close();
  }, [groupId, queryClient]);

  if (groupQuery.isPending) {
    return <PageContainer width="detail"><WorkspaceChrome crumbs={[{ label: t('title') }, { label: t('group.archive') }]} /><div className="space-y-3" role="status"><Skeleton className="h-8 w-72" /><Skeleton className="h-48 w-full" /><Skeleton className="h-28 w-full" /></div></PageContainer>;
  }
  if (groupQuery.isError) {
    return <PageContainer width="detail"><WorkspaceChrome crumbs={[{ label: t('title') }, { label: t('group.archive') }]} /><ErrorState title={t('group.archive')} description={t('group.loadFailed')} onAction={() => void groupQuery.refetch()} /></PageContainer>;
  }

  const group = groupQuery.data;
  return (
    <PageContainer width="detail">
      <WorkspaceChrome crumbs={[{ label: t('title'), to: `/agent-teams/${group.teamId}` }, { label: t('group.archive') }]} />
      <PageHeading
        title={group.title || t('group.untitled')}
        description={t('group.archiveDescription')}
        actions={<Link to="/chat" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">{t('group.openChat')}</Link>}
      />
      <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
        <h2 className="text-sm font-semibold">{t('group.transcript')}</h2>
        {group.messages.length === 0 ? <EmptyState title={t('group.transcript')} description={t('group.archiveEmpty')} /> : (
          <ol className="mt-3 space-y-4">
            {group.messages.map((message) => (
              <li key={message.id} className="min-w-0 border-t border-border pt-3 first:border-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {message.sender === 'user' ? t('group.you') : message.sender === 'system' ? t('group.system') : message.senderRole ? t(`role.${message.senderRole.replaceAll('-', '_')}` as never) : t('group.system')}
                  </span>
                  <time dateTime={message.createdAt}>{formatDateTime(message.createdAt, locale)}</time>
                  {message.recipientRole ? <span>{t('group.recipientLabel', { role: t(`role.${message.recipientRole.replaceAll('-', '_')}` as never) })}</span> : null}
                </div>
                <div className="mt-2"><MessageResponse content={message.body} enabled /></div>
                {message.runId ? <Link to="/agent-team-runs/$runId" params={{ runId: message.runId }} className="mt-2 inline-block text-[13px] text-brand-text underline underline-offset-4">{t('group.openRun')}</Link> : null}
                {message.fileReferences.length ? <ul className="mt-2 space-y-1 text-[13px]">{message.fileReferences.map((file) => <li key={`${file.documentId}:${file.revision}`} className="break-words">{file.title} · v{file.revision}</li>)}</ul> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
        <h2 className="text-sm font-semibold">{t('group.boundRuns')}</h2>
        {group.runs.length === 0 ? <p className="mt-2 text-[13px] text-muted-foreground">{t('group.noRuns')}</p> : (
          <ul className="mt-3 divide-y divide-border">
            {group.runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0"><p className="whitespace-pre-wrap break-words text-sm font-medium">{run.intent}</p><p className="mt-1 text-xs text-muted-foreground">{run.targetRole ? t(`role.${run.targetRole.replaceAll('-', '_')}` as never) : t('group.unspecifiedRole')}</p></div>
                <div className="flex items-center gap-3"><StatusBadge status={toStatusKey(run.status)} label={t(`run.status.${run.status}`)} /><Link to="/agent-team-runs/$runId" params={{ runId: run.id }} className="text-[13px] text-brand-text underline underline-offset-4">{t('group.openRun')}</Link></div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
