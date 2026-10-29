import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AgentTeamOperationView, AgentTeamRunView, CommandExecutionEvent, CommandExecutionView } from '@worklite/contracts';
import { api, parseCommandEvent } from '@/api/client';
import { agentTeamRunQueryKey, useAgentTeamRunQuery } from '@/api/queries';
import { CopyableId } from '@/components/copyable-id';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { Badge } from '@/components/ui/badge';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { runModeLabel } from './run-mode';
import { formatDateTime } from '@/i18n/format';

function roleLabel(role: string, t: (key: string) => string) {
  const key = role.replaceAll('-', '_');
  return t(`role.${key}`);
}

function JsonEvidence({ value }: { value: unknown }) {
  return <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-surface-subtle p-3 font-mono text-xs whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre>;
}

function CommandEvidence({ commandId }: { commandId: string }) {
  const { t } = useTranslation('executors');
  const [command, setCommand] = useState<CommandExecutionView | null>(null);
  const [events, setEvents] = useState<CommandExecutionEvent[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const source = new EventSource(api.commandEventsUrl(commandId), { withCredentials: true });
    const refresh = async () => {
      try {
        const value = await api.command(commandId);
        if (!disposed) setCommand(value);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : t('operations.loadFailed'));
      }
    };
    source.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseCommandEvent(message.data);
        if (event.commandId === commandId) setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event].sort((a, b) => a.sequence - b.sequence));
      } catch { /* Keep persisted command data authoritative for malformed events. */ }
    };
    void refresh();
    return () => { disposed = true; source.close(); };
  }, [commandId, t]);

  if (error) return <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p>;
  if (!command) return <Skeleton className="mt-3 h-16 w-full" role="status" />;
  return <div className="mt-3 min-w-0"><div className="flex flex-wrap items-center gap-2 text-[13px]"><StatusBadge status={toStatusKey(command.status)} label={t(`run.status.${command.status}`)} />{command.exitCode !== null ? <span>{t('operations.exitCode')}: <span className="font-mono tabular-nums">{command.exitCode}</span></span> : null}<span className="min-w-0 font-mono break-all">{command.cwd}</span></div><p className="mt-2 font-mono text-xs break-all">{command.command}</p><div className="mt-3 max-h-72 overflow-auto rounded-md border border-border bg-surface-subtle p-3" aria-label={t('operations.output')}>{events.length ? events.map((event) => <div key={event.sequence} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2"><span className="text-right font-mono text-[11px] uppercase text-muted-foreground">{event.type}</span><pre className="min-w-0 font-mono text-xs whitespace-pre-wrap break-words">{event.data}</pre></div>) : <p className="font-mono text-xs text-muted-foreground">{t('output.empty')}</p>}</div></div>;
}

function OperationEvidence({ operation }: { operation: AgentTeamOperationView }) {
  const { t } = useTranslation('executors');
  return <article className="rounded-xl border border-border bg-surface p-4 shadow-xs"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={toStatusKey(operation.status)} label={t(`run.status.${operation.status}`)} /><span className="font-mono text-xs break-all">{operation.operationKey}</span><span className="font-mono text-xs text-muted-foreground">{operation.toolName}</span></div><dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('metadata.taskKey')}</dt><dd className="mt-1 font-mono break-all">{operation.taskKey}</dd></div><div><dt className="text-muted-foreground">{t('operations.command')}</dt><dd className="mt-1 font-mono break-all">{operation.commandId ?? t('operations.noCommand')}</dd></div></dl>{operation.failureReason ? <p className="mt-2 text-[13px] text-danger" role="alert">{operation.failureReason}</p> : null}{operation.commandId ? <CommandEvidence commandId={operation.commandId} /> : null}</article>;
}

export function TeamRunDetailPage({ runId }: { runId: string }) {
  const { t } = useTranslation('executors');
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const query = useAgentTeamRunQuery('personal', runId);

  useEffect(() => {
    if (!runId) return;
    const events = new EventSource(api.executorRunEventsUrl(runId), { withCredentials: true });
    events.onmessage = () => void queryClient.invalidateQueries({ queryKey: agentTeamRunQueryKey(runId) });
    return () => events.close();
  }, [runId, queryClient]);

  if (query.isPending) return <PageContainer width="detail"><WorkspaceChrome crumbs={[{ label: 'Coding' }, { label: t('run.detail.title') }]} /><div className="space-y-3" role="status"><Skeleton className="h-8 w-72" /><Skeleton className="h-28 w-full" /><Skeleton className="h-56 w-full" /></div></PageContainer>;
  if (query.isError || !query.data) return <PageContainer width="detail"><WorkspaceChrome crumbs={[{ label: 'Coding' }, { label: t('run.detail.title') }]} /><ErrorState title={t('run.detail.title')} description={t('run.loadFailed')} onAction={() => void query.refetch()} /></PageContainer>;

  const run: AgentTeamRunView = query.data;
  const questions = run.pendingInputs.filter((input) => input.status === 'pending');
  return (
    <PageContainer width="detail">
      <WorkspaceChrome crumbs={[{ label: 'Coding', to: `/executors/${run.executorCategoryId}` }, { label: t('run.detail.title') }]} />
      <PageHeading title={t('run.detail.title')} description={run.intent} actions={<Link to="/chat" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">{t('run.continueInChat')}</Link>} />

      {run.progress ? <section className="rounded-xl border border-border bg-surface p-4 shadow-xs"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{t('progress.title')}</h2><span className="text-sm tabular-nums">{t('progress.percent', { percent: run.progress.percent })}</span></div><Progress value={run.progress.percent} className="mt-3" /><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground"><span>{t('progress.phase')}: {t(`progress.phaseValue.${run.progress.phase}`)}</span><span>{t('progress.nextStep')}: {t(`progress.nextStepValue.${run.progress.nextStep}`)}</span>{run.progress.totalAssignments > 0 ? <span>{t('progress.assignments', { completed: run.progress.completedAssignments, total: run.progress.totalAssignments })}</span> : null}{run.progress.activeDeveloperIds.length ? <span>{t('progress.activeDevelopers')}: {run.progress.activeDeveloperIds.join(', ')}</span> : null}{run.progress.waitingReason ? <span>{t(`progress.waitingReason.${run.progress.waitingReason}`)}</span> : null}</div></section> : null}

      <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
        <h2 className="text-sm font-semibold">{t('metadata.title')}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3"><StatusBadge status={toStatusKey(run.status)} label={t(`run.status.${run.status}`)} /><CopyableId value={run.id} /><span className="text-xs text-muted-foreground">v{run.teamVersion.version} · {formatDateTime(run.createdAt, locale)}</span></div>
        <dl className="mt-4 grid gap-4 text-[13px] md:grid-cols-2">
          <div><dt className="text-muted-foreground">{t('run.version')}</dt><dd className="mt-1 font-mono">v{run.teamVersion.version} · {run.teamVersion.orchestrationVersion ? `v${run.teamVersion.orchestrationVersion}` : t('run.versionUnknown')}</dd></div>
          <div><dt className="text-muted-foreground">{t('run.mode')}</dt><dd className="mt-1">{runModeLabel(t, run.mode, run.teamVersion.orchestrationVersion ?? 1, run.modeDecidedAt)}</dd></div>
          {run.modeRationale ? <div className="md:col-span-2"><dt className="text-muted-foreground">{t('run.modeRationale')}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{run.modeRationale}</dd></div> : null}
          <div><dt className="text-muted-foreground">{t('run.project')}</dt><dd className="mt-1 font-mono break-all">{run.projectDirectory}</dd></div>
          <div><dt className="text-muted-foreground">{t('run.scopeRevision')}</dt><dd className="mt-1 font-mono tabular-nums">{run.scopeRevision}</dd></div>
          {run.worktreeBasePath ? <div><dt className="text-muted-foreground">{t('run.worktreeBasePath')}</dt><dd className="mt-1 font-mono break-all">{run.worktreeBasePath}</dd></div> : null}
          {run.runBranch ? <div><dt className="text-muted-foreground">{t('run.runBranch')}</dt><dd className="mt-1 font-mono break-all">{run.runBranch}</dd></div> : null}
          <div className="md:col-span-2"><dt className="text-muted-foreground">{t('run.intent')}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{run.intent}</dd></div>
          {/* Historical evidence only: Executor roles now execute commands directly, so only
              Runs recorded under the retired grant model list command strings here. */}
          {run.authorizedCommands.length ? <div className="md:col-span-2"><dt className="text-muted-foreground">{t('run.commands')}</dt><dd className="mt-1"><ul className="space-y-1">{run.authorizedCommands.map((command) => <li key={command} className="font-mono text-xs break-all">{command}</li>)}</ul></dd></div> : null}
          {run.teamVersion.projectExecutorLaunches ? <div className="md:col-span-2"><dt className="text-muted-foreground">{t('run.executors')}</dt><dd><JsonEvidence value={run.teamVersion.projectExecutorLaunches} /></dd></div> : null}
        </dl>
      </section>

      {questions.length ? <section className="rounded-xl border border-border bg-surface p-4 shadow-xs"><h2 className="text-sm font-semibold">{t('input.title')}</h2><p className="mt-1 text-[13px] text-muted-foreground">{t('run.inputInChat')}</p><ul className="mt-3 space-y-3">{questions.map((input) => <li key={input.id} className="rounded-lg border border-border p-3"><StreamingMarkdown content={input.question} className="text-[13px]" /><p className="mt-2 text-xs text-muted-foreground">{t('run.scopeRevision')}: {input.scopeRevision}</p></li>)}</ul></section> : null}

      <section className="space-y-3"><h2 className="text-sm font-semibold">{t('tasks.title')}</h2>{run.tasks.length ? run.tasks.map((task) => <article key={task.id} className="rounded-xl border border-border bg-surface p-4 shadow-xs"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={toStatusKey(task.status)} label={t(`run.status.${task.status}`)} /><span className="font-mono text-xs break-all">{task.taskKey}</span><span className="text-[13px] text-muted-foreground">{roleLabel(task.role, (key) => t(key as never))}</span>{task.assignmentTitle ? <span className="text-[13px] text-muted-foreground">{task.assignmentTitle}</span> : null}</div>{task.progressText ? <StreamingMarkdown content={task.progressText} className="mt-3 text-[13px]" /> : null}{task.error ? <p className="mt-3 whitespace-pre-wrap break-words text-[13px] text-danger">{task.error}</p> : null}{task.result ? <JsonEvidence value={task.result} /> : null}<p className="mt-3 text-xs text-muted-foreground">{formatDateTime(task.createdAt, locale)}</p></article>) : <EmptyState title={t('tasks.title')} description={t('tasks.empty')} />}</section>

      <section className="space-y-3"><h2 className="text-sm font-semibold">{t('documents.title')}</h2>{run.documents.length ? run.documents.map((document) => <article key={document.id} className="rounded-xl border border-border bg-surface p-4 shadow-xs"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{document.title}</h3><span className="text-xs text-muted-foreground">v{document.revision} · {formatDateTime(document.createdAt, locale)}</span><StatusBadge status={toStatusKey(document.deliveryStatus)} label={t(`run.status.${document.deliveryStatus}`)} /></div><p className="mt-2 text-xs text-muted-foreground">{document.key}</p>{document.deliveryError ? <p className="mt-2 text-[13px] text-danger">{document.deliveryError}</p> : null}<StreamingMarkdown content={document.content} className="mt-3 text-[13px]" /></article>) : <EmptyState title={t('documents.title')} description={t('documents.empty')} />}</section>

      <section className="space-y-3"><h2 className="text-sm font-semibold">{t('operations.title')}</h2>{run.operations.length ? run.operations.map((operation) => <OperationEvidence key={operation.key} operation={operation} />) : <EmptyState title={t('operations.title')} description={t('operations.empty')} />}</section>

      <section className="space-y-3"><h2 className="text-sm font-semibold">{t('events.title')}</h2>{run.activities.length ? <ul className="max-h-[560px] divide-y divide-border overflow-auto rounded-xl border border-border bg-surface px-4">{run.activities.map((event) => <li key={event.sequence} className="py-3"><div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-mono">#{event.sequence}</span><span className="font-medium">{event.type}</span><time className="text-muted-foreground">{formatDateTime(event.createdAt, locale)}</time></div><JsonEvidence value={event.payload} /></li>)}</ul> : <EmptyState title={t('events.title')} description={t('events.empty')} />}</section>

      {run.outcome ? <section className="rounded-xl border border-border bg-surface p-4 shadow-xs"><h2 className="text-sm font-semibold">{t('outcome.title')}</h2><StreamingMarkdown content={run.outcome.summary} className="mt-3 text-[13px]" /><h3 className="mt-4 text-xs font-medium text-muted-foreground">{t('outcome.unresolved')}</h3>{run.outcome.unresolvedIssues.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px]">{run.outcome.unresolvedIssues.map((issue) => <li key={issue} className="whitespace-pre-wrap break-words">{issue}</li>)}</ul> : <p className="mt-1 text-[13px] text-muted-foreground">{t('outcome.noUnresolved')}</p>}<h3 className="mt-4 text-xs font-medium text-muted-foreground">{t('outcome.criteria')}</h3>{run.outcome.criterionAssessments.length ? <ul className="mt-2 space-y-3 text-[13px]">{run.outcome.criterionAssessments.map((assessment) => <li key={`${assessment.criterion}-${assessment.assessment}`}><div className="flex flex-wrap items-center gap-2"><Badge variant={assessment.assessment === 'met' ? 'success' : assessment.assessment === 'unmet' ? 'danger' : 'warning'}>{t(`outcome.assessment.${assessment.assessment}`)}</Badge><span className="whitespace-pre-wrap break-words">{assessment.criterion}</span></div>{assessment.evidence.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">{assessment.evidence.map((evidence) => <li key={evidence} className="whitespace-pre-wrap break-words">{evidence}</li>)}</ul> : <p className="mt-1 text-muted-foreground">{t('outcome.noEvidence')}</p>}</li>)}</ul> : <p className="mt-1 text-[13px] text-muted-foreground">{t('outcome.empty')}</p>}</section> : null}
    </PageContainer>
  );
}
