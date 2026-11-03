import { createFileRoute, Link } from '@tanstack/react-router';
import { Ban, Check, ExternalLink, FileStack, LoaderCircle, Pause, Play, QrCode } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { RunExecutionView } from '@/features/workflows/run-execution-view';
import { toRecordStatus } from '@/features/workflows/node-run-log';
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
  const [lifecycleAction, setLifecycleAction] = useState<'pause' | 'resume' | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [qrVisible, setQrVisible] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrUpdated, setQrUpdated] = useState(false);
  const [browserOpening, setBrowserOpening] = useState(false);
  const [browserOpenError, setBrowserOpenError] = useState<string | null>(null);
  const [, setQrExpiryTick] = useState(0);
  const qrLoadingRef = useRef(false);
  const browserOpeningRef = useRef(false);
  const terminal = run?.status === 'succeeded' || run?.status === 'failed' || run?.status === 'cancelled' || run?.status === 'timed_out';
  const pendingAction = run?.pendingAction ?? null;
  const currentQrCode = pendingAction?.qrCode ?? null;
  const pendingExpiry = pendingAction?.expiresAt ? Date.parse(pendingAction.expiresAt) : null;
  const pendingQrExpired = pendingAction?.status === 'expired' || Boolean(pendingExpiry !== null && (!Number.isFinite(pendingExpiry) || pendingExpiry <= Date.now()));
  const showQr = qrVisible && Boolean(currentQrCode) && !pendingQrExpired;

  useEffect(() => {
    if (!pendingAction?.expiresAt) return;
    const remaining = Date.parse(pendingAction.expiresAt) - Date.now();
    if (remaining <= 0) {
      setQrExpiryTick((value) => value + 1);
      return;
    }
    const timer = setTimeout(() => setQrExpiryTick((value) => value + 1), remaining + 250);
    return () => clearTimeout(timer);
  }, [pendingAction?.expiresAt]);

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
      <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
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
      <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('runs:title'), to: '/workflows' }]} />
        <EmptyState title={t('runs:detail.notFound')} description={t('runs:detail.notFoundDescription')} />
      </div>
    );
  }

  if (isError || !run) {
    return (
      <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('runs:title'), to: '/workflows' }]} />
        <ErrorState title={t('runs:logsFailed')} description={t('runs:detail.loadFailed')} onAction={() => void refetch()} />
      </div>
    );
  }

  const artifacts = run.artifacts ?? [];
  const duration = run.durationSeconds == null ? null : durationParts(run.durationSeconds);
  const failureReason = failureReasonOf(run.result, run.status);
  const canPause = run.status === 'queued' || run.status === 'running';
  const canResume = run.resumable;
  const canCancel = run.status === 'queued' || run.status === 'running' || run.status === 'paused' || run.status === 'waiting_for_input';

  const changeRunLifecycle = async (action: 'pause' | 'resume') => {
    if (lifecycleAction) return;
    setLifecycleAction(action);
    setLifecycleError(null);
    try {
      await (action === 'pause' ? api.pauseRun('personal', runId) : api.resumeRun('personal', runId));
      await queryClient.invalidateQueries({ queryKey: ['run', runId] });
    } catch (lifecycleFailure) {
      const fallback = action === 'pause' ? t('runs:pause.failed') : t('runs:resume.failed');
      setLifecycleError(lifecycleFailure instanceof Error ? lifecycleFailure.message : fallback);
    } finally {
      setLifecycleAction(null);
    }
  };

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

  const refreshPendingActionQr = async () => {
    if (qrLoadingRef.current || browserOpeningRef.current) return;
    qrLoadingRef.current = true;
    setQrLoading(true);
    setQrVisible(false);
    setQrError(null);
    setQrUpdated(false);
    try {
      const next = await api.refreshRunPendingAction('personal', runId);
      const action = next.pendingAction;
      const expiresAt = action?.expiresAt ? Date.parse(action.expiresAt) : Number.NaN;
      if (!action?.qrCode || action.status !== 'pending' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error(t('runs:pendingAction.qrUnavailable'));
      }
      queryClient.setQueryData(['run', runId], next);
      setQrVisible(true);
      setQrUpdated(true);
    } catch (failure) {
      setQrError(failure instanceof Error && failure.message ? failure.message : t('runs:pendingAction.refreshFailed'));
    } finally {
      qrLoadingRef.current = false;
      setQrLoading(false);
    }
  };

  // The login page opens in a browser on the WorkLite host, so a sign-in that
  // needs an account password or a trusted browser can still finish and resume
  // this run.
  const openPendingActionBrowser = async () => {
    if (browserOpeningRef.current || qrLoadingRef.current) return;
    browserOpeningRef.current = true;
    setBrowserOpening(true);
    setBrowserOpenError(null);
    try {
      const next = await api.openRunPendingActionBrowser('personal', runId);
      queryClient.setQueryData(['run', runId], next);
    } catch (failure) {
      setBrowserOpenError(failure instanceof Error && failure.message ? failure.message : t('runs:pendingAction.browserOpenFailed'));
    } finally {
      browserOpeningRef.current = false;
      setBrowserOpening(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome crumbs={[{ label: run.workflowName, to: '/workflows' }, { label: t('runs:detail.title') }]} />
      <PageHeading
        title={run.workflowName}
        actions={(
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              {canPause ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  onClick={() => void changeRunLifecycle('pause')}
                  disabled={cancelling || lifecycleAction !== null}
                >
                  {lifecycleAction === 'pause' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Pause aria-hidden="true" />}
                  {t('runs:pause.action')}
                </Button>
              ) : null}
              {canResume ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  onClick={() => void changeRunLifecycle('resume')}
                  disabled={cancelling || lifecycleAction !== null}
                >
                  {lifecycleAction === 'resume' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
                  {t('runs:resume.action')}
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" variant="destructive" size="compact" onClick={() => { setCancelError(null); setCancelOpen(true); }} disabled={cancelling || lifecycleAction !== null}>
                  <Ban aria-hidden="true" />
                  {t('runs:cancel.action')}
                </Button>
              ) : null}
            </div>
            {lifecycleError ? <p className="text-right text-[13px] text-danger" role="alert">{lifecycleError}</p> : null}
          </div>
        )}
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

      {pendingAction ? (
        <section className="mt-6 rounded-lg border border-border bg-surface-subtle p-4" aria-labelledby="run-detail-pending-action-title">
          <h2 id="run-detail-pending-action-title" className="flex items-center gap-2 text-sm font-semibold"><QrCode className="size-4 text-muted-foreground" aria-hidden="true" />{pendingAction.title}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{pendingAction.description}</p>
          {showQr && currentQrCode ? (
            <div className="mt-4">
              <img src={currentQrCode} alt={t('runs:pendingAction.qrAlt')} className="size-48 rounded-md border border-border bg-white object-contain p-2" />
            </div>
          ) : null}
          {pendingQrExpired ? <p className="mt-3 text-[13px] text-muted-foreground" role="status">{t('runs:pendingAction.expired')}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" size="compact" onClick={() => void refreshPendingActionQr()} disabled={qrLoading || browserOpening} aria-busy={qrLoading}>
              {qrLoading ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <QrCode aria-hidden="true" />}
              {qrLoading ? t('runs:pendingAction.replacing') : showQr ? t('runs:pendingAction.refresh') : pendingQrExpired ? t('runs:pendingAction.getAgain') : t('runs:pendingAction.get')}
            </Button>
            {pendingAction.type === 'wechat_login' ? (
              <Button type="button" size="compact" variant="secondary" onClick={() => void openPendingActionBrowser()} disabled={qrLoading || browserOpening} aria-busy={browserOpening}>
                {browserOpening ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}
                {browserOpening ? t('runs:pendingAction.openingBrowser') : t('runs:pendingAction.openBrowser')}
              </Button>
            ) : null}
          </div>
          {pendingAction.type === 'wechat_login' ? <p className="mt-2 text-[13px] text-muted-foreground">{t('runs:pendingAction.browserHelp')}</p> : null}
          {qrUpdated ? <p className="mt-2 flex items-center gap-1.5 text-[13px] text-success" role="status"><Check className="size-3.5" aria-hidden="true" />{t('runs:pendingAction.refreshed')}</p> : null}
          {qrError ? <p className="mt-2 text-[13px] text-danger" role="alert">{qrError}</p> : null}
          {browserOpenError ? <p className="mt-2 text-[13px] text-danger" role="alert">{browserOpenError}</p> : null}
        </section>
      ) : null}

      <section className="mt-6" aria-labelledby="run-detail-logs-title">
        <h2 id="run-detail-logs-title" className="text-sm font-semibold">{t('runs:logs')}</h2>
        <RunExecutionView run={run} locale={locale} loading={false} failed={false} />
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
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{artifact.name}</span>
                      {artifact.supersededAt ? <span className="shrink-0 rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] text-muted-foreground">{t('runs:artifactSuperseded')}</span> : null}
                    </span>
                    <span className="text-[13px] text-muted-foreground">{artifact.format}</span>
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
