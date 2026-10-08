import { Link } from '@tanstack/react-router';
import { ChevronDown, Clipboard, LoaderCircle, RotateCcw, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunView, WorkflowNodeActivityView, WorkflowNodeRunView } from '@worklite/contracts';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { focusRing } from '@/components/ui/interaction';
import { durationParts, formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

type RunRecordStatus = 'queued' | 'running' | 'paused' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

function toRecordStatus(status: RunView['status'] | WorkflowNodeRunView['status']): RunRecordStatus {
  if (status === 'succeeded') return 'completed';
  if (status === 'timed_out') return 'failed';
  return status as RunRecordStatus;
}

const MODEL_NODE_TYPES = new Set(['worklite/agent', 'worklite/image']);

function payloadText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function nodeRunDurationSeconds(nodeRun: WorkflowNodeRunView): number | null {
  if (!nodeRun.startedAt || !nodeRun.finishedAt) return null;
  return Math.max(0, Math.round((new Date(nodeRun.finishedAt).getTime() - new Date(nodeRun.startedAt).getTime()) / 1000));
}

type CopyableBodyProps = {
  label: string;
  body: string;
  copyLabel: string;
};

function CopyableBody({ label, body, copyLabel }: CopyableBodyProps) {
  const { t } = useTranslation('runs');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button type="button" variant="ghost" size="compact" onClick={() => void copy()} aria-label={copyLabel}>
          <Clipboard aria-hidden="true" />
          {copied ? t('nodeLog.copied') : t('nodeLog.copy')}
        </Button>
      </div>
      {/* A bounded scroll container must be reachable without a pointer, so it takes focus
          while keeping its non-interactive group role. */}
      <div
        role="group"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={label}
        className={cn('mt-1 max-h-64 overflow-auto rounded-md border border-border bg-surface px-2 py-1.5', focusRing)}
      >
        <pre className="font-mono text-xs whitespace-pre-wrap break-words">{body}</pre>
      </div>
    </div>
  );
}

function ActivityEntry({ activity, locale }: { activity: WorkflowNodeActivityView; locale: AppLocale }) {
  const { t } = useTranslation('runs');
  const detail = activity.detail;

  function summary(): string {
    if (detail.phase === 'node.setup') return t('nodeLog.phase.setup', { type: detail.type, version: detail.typeVersion, policy: detail.errorPolicy });
    if (detail.phase === 'node.attempt') {
      return detail.automaticRetry
        ? t('nodeLog.automaticRetry', { attempt: detail.attempt, attempts: detail.attempts })
        : t('nodeLog.attempt', { attempt: detail.attempt, attempts: detail.attempts });
    }
    if (detail.phase === 'model.round') return t('nodeLog.modelRound', { round: detail.round + 1, model: detail.model, finishReason: detail.finishReason ?? t('nodeLog.finishReasonUnknown') });
    if (detail.phase === 'skill.script') return t('nodeLog.skillScript', { skill: detail.skillName, path: detail.scriptPath, exitCode: detail.exitCode ?? t('nodeLog.exitCodeUnknown') });
    if (detail.phase === 'mcp.call') return t('nodeLog.mcpCall', { tool: detail.toolName, status: detail.status });
    return detail.terminal ? t('nodeLog.edgeTerminal') : t('nodeLog.edgeDecision');
  }

  return (
    <li className="border-l-2 border-border pl-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{t(`nodeLog.phaseLabel.${detail.phase}` as never)}</span>
        <span className="text-[13px]">{summary()}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{formatDateTime(activity.occurredAt, locale)}</span>
      </div>
      {detail.phase === 'skill.script' ? (
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{t('nodeLog.commandExecution', { id: detail.commandExecutionId })}</p>
      ) : null}
      {detail.phase === 'model.round' && detail.contextDropped > 0 ? (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('nodeLog.contextDropped', { count: detail.contextDropped })}</p>
      ) : null}
      {detail.phase === 'edge.decision' ? (
        <ul className="mt-1 grid gap-0.5">
          {detail.decisions.map((decision) => (
            <li key={decision.edgeId} className="font-mono text-[11px] text-muted-foreground">
              {decision.traversed ? t('nodeLog.edgeTraversed', { target: decision.targetNodeId, port: decision.targetPort }) : t('nodeLog.edgeSkipped', { target: decision.targetNodeId, port: decision.targetPort })}
              {' · '}
              {decision.condition}
              {decision.maxTraversals !== null ? ` · ${t('nodeLog.edgeTraversals', { count: decision.traversals, max: decision.maxTraversals })}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type NodeRunLogEntryProps = {
  nodeRun: WorkflowNodeRunView;
  runId: string;
  locale: AppLocale;
  nodeLabel?: string;
};

function NodeRunLogEntry({ nodeRun, runId, locale, nodeLabel }: NodeRunLogEntryProps) {
  const { t } = useTranslation(['runs', 'common']);
  const [expanded, setExpanded] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const durationSeconds = nodeRunDurationSeconds(nodeRun);
  const duration = durationSeconds == null ? null : durationParts(durationSeconds);
  const input = payloadText(nodeRun.input);
  const output = payloadText(nodeRun.output);
  const showRequestLogs = MODEL_NODE_TYPES.has(nodeRun.type);

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
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className={cn('flex w-full items-center gap-2 text-left', focusRing)}
      >
        <StatusBadge status={toRecordStatus(nodeRun.status)} />
        <span className="min-w-0 truncate text-xs font-medium">{nodeLabel ?? nodeRun.type}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{nodeRun.type}</span>
        <span className="font-mono text-xs text-muted-foreground">#{nodeRun.position} · {nodeRun.nodeId}</span>
        <ChevronDown className={cn('ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-[120ms]', expanded && 'rotate-180')} aria-hidden="true" />
      </button>
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
      {expanded ? (
        <div className="mt-2 border-t border-border pt-2">
          {input ? <CopyableBody label={t('runs:nodeLog.input')} body={input} copyLabel={t('runs:nodeLog.copyInput')} /> : null}
          {nodeRun.activity.length > 0 ? (
            <section className="mt-3">
              <h4 className="text-xs font-medium text-muted-foreground">{t('runs:nodeLog.activity')}</h4>
              <ul className="mt-1 grid gap-1.5">
                {nodeRun.activity.map((activity) => <ActivityEntry key={activity.sequence} activity={activity} locale={locale} />)}
              </ul>
            </section>
          ) : (
            <p className="mt-3 text-[13px] text-muted-foreground">{t('runs:nodeLog.noActivity')}</p>
          )}
          {nodeRun.streamedOutput ? <CopyableBody label={t('runs:nodeLog.streamedOutput')} body={nodeRun.streamedOutput} copyLabel={t('runs:nodeLog.copyStreamedOutput')} /> : null}
          {output ? <CopyableBody label={t('runs:nodeLog.output')} body={output} copyLabel={t('runs:nodeLog.copyOutput')} /> : null}
          {showRequestLogs ? (
            <div className="mt-3">
              <Link
                to="/logs"
                search={{ tab: 'requests', range: '24h', workflowRunId: runId }}
                className={cn('inline-flex items-center gap-1.5 text-[13px] text-brand-text hover:underline', focusRing)}
              >
                <ScrollText className="size-3.5" aria-hidden="true" />
                {t('runs:nodeLog.viewRequestLogs')}
              </Link>
              <p className="mt-1 text-[11px] text-muted-foreground">{t('runs:nodeLog.requestLogRetention')}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export { NodeRunLogEntry, toRecordStatus };
