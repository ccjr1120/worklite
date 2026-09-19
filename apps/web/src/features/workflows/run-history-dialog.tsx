import { Link } from '@tanstack/react-router';
import { AlertCircle, ChevronDown, FileStack, LoaderCircle, QrCode, RotateCcw, ScrollText, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactView, RunProgressEvent, RunView, WorkflowNodeRunView } from '@worklite/contracts';
import { StatusBadge } from '@/components/status-badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLocale } from '@/components/locale-provider';
import { durationParts, formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { useRunQuery, useRunsQuery } from '@/api/queries';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

type RunRecordStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

function toRecordStatus(status: RunView['status'] | WorkflowNodeRunView['status']): RunRecordStatus {
  if (status === 'succeeded') return 'completed';
  if (status === 'timed_out') return 'failed';
  return status as RunRecordStatus;
}

type WorkflowRunHistoryDialogProps = {
  open: boolean;
  workflowId: string;
  workflowName: string;
  initialStatus?: 'failed';
  onOpenChange: (open: boolean) => void;
};

function WorkflowRunHistoryDialog({ open, workflowId, workflowName, initialStatus, onOpenChange }: WorkflowRunHistoryDialogProps) {
  const { t } = useTranslation(['runs', 'workflows', 'common']);
  const { locale } = useLocale();
  const { data: allRuns = [], isLoading, isError } = useRunsQuery('personal');
  const runs = useMemo(() => allRuns.filter((run) => run.workflowId === workflowId), [allRuns, workflowId]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [focusedInitialRun, setFocusedInitialRun] = useState(false);

  useEffect(() => {
    if (initialStatus !== 'failed' || isLoading || focusedInitialRun) return;
    const target = runs.find((run) => run.status === 'failed' || run.status === 'timed_out');
    setExpandedRunId(target?.id ?? null);
    setFocusedInitialRun(true);
  }, [focusedInitialRun, initialStatus, isLoading, runs]);

  useEffect(() => {
    if (!expandedRunId) return;
    document.getElementById(`workflow-run-${expandedRunId}`)?.scrollIntoView({ block: 'nearest' });
  }, [expandedRunId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl overflow-hidden p-0">
        <div className="flex max-h-[80vh] flex-col">
          <DialogHeader className="border-b border-border p-5 pb-4">
            <DialogTitle>{t('runs:title')}</DialogTitle>
            <DialogDescription>{workflowName}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">{t('runs:loading')}</p>
            ) : isError ? (
              <p className="text-sm text-danger">{t('runs:loadFailed')}</p>
            ) : runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('runs:empty.description')}</p>
            ) : (
              <ul className="grid gap-3">
                {runs.map((run) => (
                  <RunHistoryRow
                    key={run.id}
                    run={run}
                    locale={locale}
                    expanded={expandedRunId === run.id}
                    onToggle={() => setExpandedRunId((current) => (current === run.id ? null : run.id))}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type RunHistoryRowProps = {
  run: RunView;
  locale: AppLocale;
  expanded: boolean;
  onToggle: () => void;
};

function RunHistoryRow({ run, locale, expanded, onToggle }: RunHistoryRowProps) {
  const { t } = useTranslation(['runs', 'common']);
  const { data: runDetail, isLoading, isError } = useRunQuery('personal', run.id, expanded);
  const nodeRuns = runDetail?.nodeRuns ?? [];
  const artifacts = runDetail?.artifacts ?? [];
  const failedNode = nodeRuns.find((nodeRun) => nodeRun.status === 'failed');
  const failureReason = failedNode?.error ?? getRunFailureReason(runDetail);
  const duration = run.durationSeconds == null ? null : durationParts(run.durationSeconds);
  const [qrReplacing, setQrReplacing] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [expiryTick, setExpiryTick] = useState(0);

  useEffect(() => {
    if (!expanded) return;
    const source = new EventSource(api.runEventsUrl(run.id), { withCredentials: true });
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RunProgressEvent;
        if (event.type === 'node.delta') return;
        void queryClient.invalidateQueries({ queryKey: ['run', run.id] }).catch(() => undefined);
        void queryClient.invalidateQueries({ queryKey: ['runs'] }).catch(() => undefined);
      } catch {
        // Ignore malformed transport data; the next query refresh restores state.
      }
    };
    return () => source.close();
  }, [expanded, run.id]);

  const pendingAction = runDetail?.pendingAction ?? null;
  const hasPendingAction = pendingAction !== null;
  const pendingStatus = pendingAction?.status ?? null;
  const pendingExpiresAt = pendingAction?.expiresAt ?? null;

  // An expired code is replaced automatically: the server can observe the staleness,
  // so the panel never asks the user to refresh it. Each distinct expiry marker is
  // attempted once, so a server that returns an equally stale code cannot spin.
  const replacedExpiryRef = useRef('');

  useEffect(() => {
    if (!expanded || !hasPendingAction) return;
    const expired = pendingStatus === 'expired' || (pendingExpiresAt !== null && Date.parse(pendingExpiresAt) <= Date.now());
    const marker = `${pendingStatus ?? ''}:${pendingExpiresAt ?? ''}`;
    if (!expired || replacedExpiryRef.current === marker) return;
    replacedExpiryRef.current = marker;
    let cancelled = false;
    setQrReplacing(true);
    void api
      .refreshRunPendingAction('personal', run.id)
      .then((next) => {
        if (!cancelled) queryClient.setQueryData(['run', run.id], next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setQrReplacing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, hasPendingAction, pendingStatus, pendingExpiresAt, expiryTick, run.id]);

  useEffect(() => {
    if (!expanded || pendingExpiresAt === null) return;
    const remaining = Date.parse(pendingExpiresAt) - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setExpiryTick((value) => value + 1), remaining + 250);
    return () => clearTimeout(timer);
  }, [expanded, pendingExpiresAt]);

  async function cancelRun() {
    setCancelBusy(true);
    try {
      const next = await api.cancelRun('personal', run.id);
      queryClient.setQueryData(['run', run.id], next);
      void queryClient.invalidateQueries({ queryKey: ['runs'] }).catch(() => undefined);
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <li>
      <article id={`workflow-run-${run.id}`} className="overflow-hidden rounded-lg border border-border bg-surface">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`workflow-run-${run.id}-details`}
          className="grid w-full min-w-0 gap-3 p-4 text-left transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto] md:items-center"
        >
          <StatusBadge status={toRecordStatus(run.status)} />
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{run.version}</span>
          <span className="min-w-0 truncate text-[13px] text-muted-foreground">{run.currentStep ?? t('common:empty.dash')}</span>
          <span className="min-w-0 truncate text-right text-[13px] tabular-nums text-muted-foreground">
            {formatDateTime(run.startedAt, locale)}
            {duration ? ` · ${t('common:duration.compact', duration)}` : ''}
            {run.initiator ? ` · ${run.initiator}` : ''}
          </span>
          <ChevronDown className={cn('size-4 justify-self-end text-muted-foreground transition-transform duration-[120ms]', expanded && 'rotate-180')} aria-hidden="true" />
        </button>
        <div id={`workflow-run-${run.id}-details`} hidden={!expanded} className="border-t border-border px-4 py-3">
          {expanded ? (
            <div className="grid gap-4">
              {pendingAction ? (
                <section className="rounded-lg border border-border bg-surface-subtle p-4" aria-labelledby={`workflow-run-${run.id}-pending-title`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h4 id={`workflow-run-${run.id}-pending-title`} className="flex items-center gap-2 text-sm font-semibold"><QrCode className="size-4 text-muted-foreground" aria-hidden="true" />{pendingAction.title}</h4>
                      <p className="mt-1 text-[13px] text-muted-foreground">{pendingAction.description}</p>
                    </div>
                    <StatusBadge status="waiting_for_input" />
                  </div>
                  {pendingAction.qrCode ? <img src={pendingAction.qrCode} alt={t('runs:pendingAction.qrAlt')} className={cn('mt-4 size-48 rounded-md border border-border bg-white object-contain p-2 transition-opacity', qrReplacing && 'opacity-40')} /> : null}
                  {qrReplacing ? (
                    <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
                      <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                      {t('runs:pendingAction.replacing')}
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button type="button" size="compact" variant="ghost" onClick={() => void cancelRun()} disabled={cancelBusy}>{cancelBusy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <X aria-hidden="true" />}{t('runs:pendingAction.cancel')}</Button>
                  </div>
                </section>
              ) : null}
              <section aria-labelledby={`workflow-run-${run.id}-logs-title`}>
                <div className="flex items-center gap-2">
                  <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
                  <h4 id={`workflow-run-${run.id}-logs-title`} className="text-sm font-semibold">{t('runs:logs')}</h4>
                </div>
                {failureReason ? (
                  <div className="mt-2 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger" role="alert">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <p><span className="font-medium">{t('runs:failureReason')}:</span> {failureReason}</p>
                  </div>
                ) : null}
                {isLoading ? (
                  <p className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                    <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                    {t('runs:logsLoading')}
                  </p>
                ) : isError ? (
                  <p className="mt-2 text-[13px] text-danger">{t('runs:logsFailed')}</p>
                ) : nodeRuns.length === 0 ? (
                  <p className="mt-2 text-[13px] text-muted-foreground">{t('runs:noLogs')}</p>
                ) : (
                  <ol className="mt-2 grid gap-2">
                    {nodeRuns.map((nodeRun) => <NodeRunLogRow key={nodeRun.id} nodeRun={nodeRun} locale={locale} runId={run.id} />)}
                  </ol>
                )}
              </section>
              {run.hasArtifactNode ? (
                <section aria-labelledby={`workflow-run-${run.id}-artifacts-title`}>
                  <div className="flex items-center gap-2">
                    <FileStack className="size-4 text-muted-foreground" aria-hidden="true" />
                    <h4 id={`workflow-run-${run.id}-artifacts-title`} className="text-sm font-semibold">{t('runs:artifacts')}</h4>
                  </div>
                  {isLoading ? (
                    <p className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
                      <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                      {t('runs:artifactsLoading')}
                    </p>
                  ) : isError ? (
                    <p className="mt-2 text-[13px] text-danger">{t('runs:artifactsFailed')}</p>
                  ) : artifacts.length === 0 ? (
                    <p className="mt-2 text-[13px] text-muted-foreground">{t('runs:noArtifacts')}</p>
                  ) : (
                    <ul className="mt-2 grid gap-2 lg:grid-cols-2">
                      {artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} locale={locale} />)}
                    </ul>
                  )}
                </section>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    </li>
  );
}

type NodeRunLogRowProps = {
  nodeRun: WorkflowNodeRunView;
  locale: AppLocale;
  runId: string;
};

function NodeRunLogRow({ nodeRun, locale, runId }: NodeRunLogRowProps) {
  const { t } = useTranslation(['runs', 'common']);
  const durationSeconds = getNodeRunDurationSeconds(nodeRun);
  const duration = durationSeconds == null ? null : durationParts(durationSeconds);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retryNode() {
    setRetryBusy(true);
    setRetryError(null);
    try {
      const next = await api.retryRunNode('personal', runId, nodeRun.id);
      queryClient.setQueryData(['run', runId], next);
      void queryClient.invalidateQueries({ queryKey: ['runs'] }).catch(() => undefined);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : t('runs:nodeRetry.failed'));
    } finally {
      setRetryBusy(false);
    }
  }

  return (
    <li className="rounded-md border border-border bg-surface-subtle px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={toRecordStatus(nodeRun.status)} />
        <span className="font-mono text-xs">{nodeRun.type}</span>
        <span className="font-mono text-xs text-muted-foreground">#{nodeRun.position} · {nodeRun.nodeId}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
        <span>{nodeRun.startedAt ? formatDateTime(nodeRun.startedAt, locale) : t('common:empty.dash')}</span>
        {duration ? <span>{t('common:duration.compact', duration)}</span> : null}
        {nodeRun.retryCount > 0 ? <span>{t('runs:retryCount', { count: nodeRun.retryCount })}</span> : null}
      </div>
      {nodeRun.error ? <p className="mt-2 border-l-2 border-danger pl-2 text-[13px] text-danger" role="alert">{nodeRun.error}</p> : null}
      {retryError ? <p className="mt-2 border-l-2 border-danger pl-2 text-[13px] text-danger" role="alert">{retryError}</p> : null}
      {nodeRun.retryable ? (
        <div className="mt-2">
          <Button type="button" size="compact" variant="secondary" onClick={() => void retryNode()} disabled={retryBusy}>
            {retryBusy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
            {t('runs:nodeRetry.action')}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function getNodeRunDurationSeconds(nodeRun: WorkflowNodeRunView): number | null {
  if (!nodeRun.startedAt || !nodeRun.finishedAt) return null;
  return Math.max(0, Math.round((new Date(nodeRun.finishedAt).getTime() - new Date(nodeRun.startedAt).getTime()) / 1000));
}

function getRunFailureReason(run: RunView | undefined): string | null {
  if (!run || (run.status !== 'failed' && run.status !== 'timed_out')) return null;
  if (!run.result || typeof run.result !== 'object' || Array.isArray(run.result)) return null;
  const message = (run.result as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() ? message : null;
}

type ArtifactRowProps = {
  artifact: ArtifactView;
  locale: AppLocale;
};

function ArtifactRow({ artifact, locale }: ArtifactRowProps) {
  return (
    <li>
      <Link
        to="/artifacts/$artifactId"
        params={{ artifactId: artifact.id }}
        className="flex flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2 transition-colors duration-[120ms] hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,1fr)] sm:items-center sm:gap-3"
      >
        <span className="min-w-0 truncate text-sm font-medium">{artifact.name}</span>
        <span className="text-[13px] text-muted-foreground">{artifact.type}</span>
        <span className="text-[13px] tabular-nums text-muted-foreground">{artifact.size}</span>
        <span className="text-[13px] tabular-nums">{formatDateTime(artifact.createdAt, locale)}</span>
      </Link>
    </li>
  );
}

export { WorkflowRunHistoryDialog };
