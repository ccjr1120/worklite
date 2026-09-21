import { createFileRoute, Link } from '@tanstack/react-router';
import { Ban, FileStack, LoaderCircle, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunProgressEvent } from '@worklite/contracts';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { CopyableId } from '@/components/copyable-id';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { NodeRunLogEntry, toRecordStatus } from '@/features/workflows/node-run-log';
import { applyRunProgressEvent } from '@/features/workflows/run-progress';
import { durationParts, formatDateTime } from '@/i18n/format';
import { api } from '@/api/client';
import { useRunQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { ApiError } from '@/api/client';

export const Route = createFileRoute('/runs/$runId')({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { locale } = useLocale();
  const { runId } = Route.useParams();
  const { data: run, isLoading, isError, error, refetch } = useRunQuery('personal', runId);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const terminal = run?.status === 'succeeded' || run?.status === 'failed' || run?.status === 'cancelled' || run?.status === 'timed_out';

  useEffect(() => {
    if (!run || terminal) return;
    const source = new EventSource(api.runEventsUrl(runId), { withCredentials: true });
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RunProgressEvent;
        if (applyRunProgressEvent(runId, event)) return;
        void queryClient.invalidateQueries({ queryKey: ['run', runId] }).catch(() => undefined);
      } catch {
        // Ignore malformed transport data; the next query refresh restores state.
      }
    };
    return () => source.close();
  }, [run, runId, terminal]);

  if (isLoading) {
    return (
      <div className="w-full px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('runs:title'), to: '/workflows' }]} />
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">{t('runs:logsLoading')}</span>
          <Skeleton className="h-8 w-64" />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-4 w-32" />)}
          </div>
          <Skeleton className="mt-6 h-64 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  const notFound = isError && error instanceof ApiError && error.status === 404;

  if (notFound || (!isError && !run)) {
    return (
      <div className="w-full px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('runs:title'), to: '/workflows' }]} />
        <EmptyState title={t('runs:detail.notFound')} description={t('runs:detail.notFoundDescription')} />
      </div>
    );
  }

  if (isError || !run) {
    return (
      <div className="w-full px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('runs:title'), to: '/workflows' }]} />
        <ErrorState title={t('runs:logsFailed')} description={t('runs:detail.loadFailed')} onAction={() => void refetch()} />
      </div>
    );
  }

  const nodeRuns = run.nodeRuns ?? [];
  const artifacts = run.artifacts ?? [];
  const duration = run.durationSeconds == null ? null : durationParts(run.durationSeconds);
  const failureReason = failureReasonOf(run.result, run.status);
  const canCancel = run.status === 'queued' || run.status === 'running' || run.status === 'waiting_for_input';

  const cancelRun = async () => {
    if (!canCancel || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelRun('personal', runId);
      setCancelOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['run', runId] });
    } catch (cancelFailure) {
      setCancelError(cancelFailure instanceof Error ? cancelFailure.message : t('runs:cancel.failed'));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="w-full px-6 py-6">
      <WorkspaceChrome crumbs={[{ label: run.workflowName, to: '/workflows' }, { label: t('runs:detail.title') }]} />
      <PageHeading
        title={run.workflowName}
        actions={canCancel ? (
          <Button type="button" variant="destructive" size="compact" onClick={() => { setCancelError(null); setCancelOpen(true); }} disabled={cancelling}>
            <Ban aria-hidden="true" />
            {t('runs:cancel.action')}
          </Button>
        ) : null}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
        <StatusBadge status={toRecordStatus(run.status)} />
        <CopyableId value={run.id} />
        <span>{run.version}</span>
        <span>{run.initiator}</span>
        <span className="tabular-nums">{formatDateTime(run.startedAt, locale)}</span>
        {duration ? <span className="tabular-nums">{t('common:duration.compact', duration)}</span> : null}
      </div>


      <Dialog open={cancelOpen} onOpenChange={(open) => { if (!cancelling) setCancelOpen(open); }}>
        <DialogContent aria-busy={cancelling}>
          <DialogHeader>
            <DialogTitle>{t('runs:cancel.title')}</DialogTitle>
            <DialogDescription>{t('runs:cancel.description')}</DialogDescription>
          </DialogHeader>
          {cancelError ? <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger" role="alert">{cancelError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setCancelOpen(false)} disabled={cancelling}>{t('common:actions.cancel')}</Button>
            <Button type="button" variant="destructive" onClick={() => void cancelRun()} disabled={cancelling}>
              {cancelling ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Ban aria-hidden="true" />}
              {cancelling ? t('runs:cancel.cancelling') : t('runs:cancel.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {failureReason ? (
        <p className="mt-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger" role="alert">
          <span className="font-medium">{t('runs:failureReason')}:</span> {failureReason}
        </p>
      ) : null}

      <section className="mt-6" aria-labelledby="run-detail-logs-title">
        <div className="flex items-center gap-2">
          <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 id="run-detail-logs-title" className="text-sm font-semibold">{t('runs:logs')}</h2>
        </div>
        {nodeRuns.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">{t('runs:detail.noNodeRuns')}</p>
        ) : (
          <ol className="mt-2 grid gap-2">
            {nodeRuns.map((nodeRun) => <NodeRunLogEntry key={nodeRun.id} nodeRun={nodeRun} locale={locale} runId={run.id} />)}
          </ol>
        )}
      </section>

      {run.hasArtifactNode ? (
        <section className="mt-6" aria-labelledby="run-detail-artifacts-title">
          <div className="flex items-center gap-2">
            <FileStack className="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 id="run-detail-artifacts-title" className="text-sm font-semibold">{t('runs:artifacts')}</h2>
          </div>
          {artifacts.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">{t('runs:noArtifacts')}</p>
          ) : (
            <ul className="mt-2 grid gap-2 lg:grid-cols-2">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <Link
                    to="/artifacts/$artifactId"
                    params={{ artifactId: artifact.id }}
                    className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 transition-colors duration-[120ms] hover:bg-surface-subtle sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,1fr)] sm:items-center sm:gap-3"
                  >
                    <span className="min-w-0 truncate text-sm font-medium">{artifact.name}</span>
                    <span className="text-[13px] text-muted-foreground">{artifact.type}</span>
                    <span className="text-[13px] tabular-nums text-muted-foreground">{artifact.size}</span>
                    <span className="text-[13px] tabular-nums">{formatDateTime(artifact.createdAt, locale)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

function failureReasonOf(result: unknown, status: string): string | null {
  if (status !== 'failed' && status !== 'timed_out') return null;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const message = (result as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() ? message : null;
}
