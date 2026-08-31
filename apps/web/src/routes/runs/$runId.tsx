import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { focusRing, surfaceInteraction } from '@/components/ui/interaction';
import { CopyableId } from '@/components/copyable-id';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { durationParts, formatDateTime } from '@/i18n/format';
import { api, parseRunProgressEvent } from '@/api/client';
import { useRunQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import type { RunProgressEvent, WorkflowNodeRunView } from '@worklite/contracts';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/runs/$runId')({
  component: RunDetailsPage,
});

function RunDetailsPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { locale } = useLocale();
  const { runId } = Route.useParams();
  const workspaceSlug = "personal";
  const { data: run } = useRunQuery(workspaceSlug, runId);
  const steps = run?.nodeRuns ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeDeltas, setNodeDeltas] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<RunProgressEvent[]>([]);
  const [following, setFollowing] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const selected = steps.find((step) => step.id === selectedId);
  const runArtifacts = run?.artifacts ?? [];
  const cancellable = run?.status === 'running' || run?.status === 'queued';

  useEffect(() => {
    setSelectedId((current) => current && steps.some((step) => step.id === current)
      ? current
      : steps.find((step) => step.status === 'running')?.id ?? steps[0]?.id ?? null);
  }, [run?.id, steps]);

  useEffect(() => {
    if (!run || ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) return;
    const source = new EventSource(api.runEventsUrl(runId), { withCredentials: true });
    source.onmessage = (message) => {
      try {
        const event = parseRunProgressEvent(message.data);
        setEvents((current) => [...current, event].slice(-200));
        if (event.type === 'node.delta') {
          const payload = event.payload as { nodeId?: string; delta?: string };
          if (payload.nodeId && typeof payload.delta === 'string') setNodeDeltas((current) => ({ ...current, [payload.nodeId!]: `${current[payload.nodeId!] ?? ''}${payload.delta}` }));
        }
        void queryClient.invalidateQueries({ queryKey: ['run', runId] });
        void queryClient.invalidateQueries({ queryKey: ['runs'] });
      } catch {
        // Ignore malformed events and let EventSource reconnect.
      }
    };
    return () => source.close();
  }, [run?.id, run?.status, runId]);

  async function cancelRun() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.cancelRun(workspaceSlug, runId);
      await queryClient.invalidateQueries({ queryKey: ['run', runId] });
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t('details.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  }

  const duration = useMemo(() => {
    if (run?.durationSeconds == null) {
      return t('common:empty.dash');
    }
    return t('common:duration.compact', durationParts(run.durationSeconds));
  }, [run, t]);

  if (!run) {
    return (
      <div className="px-6 py-6">
        <PageHeading title={t('details.unavailableTitle')} description={t('details.unavailableDescription')} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: '/runs' },
          { label: run.workflowName },
        ]}
        actions={
          cancellable ? (
            <Button variant="destructive" size="compact" onClick={() => void cancelRun()} disabled={cancelling}>
              {cancelling ? t('details.cancelling') : t('details.cancel')}
            </Button>
          ) : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{run.workflowName}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
                <StatusBadge status={run.status === 'succeeded' ? 'completed' : run.status === 'timed_out' ? 'failed' : run.status} />
                <CopyableId value={run.id} />
                <span>{t('details.version', { version: run.version })}</span>
                <span className="tabular-nums">{formatDateTime(run.startedAt, locale)}</span>
                <span className="tabular-nums">{duration}</span>
                <span>{run.initiator}</span>
              </div>
            </div>
          </div>

          {run.status === 'failed' ? (
            <div className="mt-6 rounded-lg border border-danger/30 bg-danger-subtle p-4 text-[13px]">
              {t('details.failed', { step: run.currentStep })}{' '}
              <Link className="font-medium underline" to="/workflows/$workflowId" params={{ workflowId: run.workflowId }}>
                {t('details.openWorkflow')}
              </Link>
            </div>
          ) : null}

          <ol className="mt-8 max-w-2xl">
            {steps.map((step, index) => (
              <li key={step.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      'mt-1 size-2.5 rounded-full',
                      step.status === 'succeeded' && 'bg-success',
                      step.status === 'failed' && 'bg-danger',
                      step.status === 'running' && 'bg-brand',
                      step.status === 'queued' && 'bg-border',
                    )}
                    aria-hidden="true"
                  />
                  {index < steps.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                </div>
                <button
                  type="button"
                  className={cn(
                    'mb-4 w-full rounded-lg border bg-surface p-3 text-left hover:bg-surface-subtle',
                    surfaceInteraction,
                    focusRing,
                    selectedId === step.id ? 'border-brand bg-brand-subtle' : 'border-border hover:border-foreground/20',
                  )}
                  aria-pressed={selectedId === step.id}
                  onClick={() => setSelectedId(step.id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{nodeLabel(step)}</span>
                    <StatusBadge status={toUiStatus(step.status)} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{step.type} · {formatValue(step.output ?? nodeDeltas[step.nodeId])}</p>
                </button>
              </li>
            ))}
          </ol>
        </div>
        <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 lg:block">
          <h2 className="text-sm font-semibold">{selected ? nodeLabel(selected) : t('details.stepFallback')}</h2>
          <dl className="mt-4 space-y-3 text-[13px]">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('details.input')}</dt>
              <dd className="mt-1 max-h-24 overflow-auto font-mono text-xs">{selected ? formatValue(selected.input) : t('common:empty.dash')}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('details.model')}</dt>
              <dd className="mt-1">{nodeProcessor(selected?.type)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('details.retries')}</dt>
              <dd className="mt-1 tabular-nums">{selected?.retryCount ?? 0}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Output</dt>
              <dd className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">{selected ? formatValue(selected.output ?? nodeDeltas[selected.nodeId]) : t('common:empty.dash')}</dd>
            </div>
          </dl>
          {runArtifacts.length ? (
            <div className="mt-6">
              <h3 className="text-xs font-medium text-muted-foreground">{t('details.artifacts')}</h3>
              <ul className="mt-2 space-y-1">
                {runArtifacts.map((item) => (
                  <li key={item.id}>
                    <Link className="font-mono text-[13px] hover:text-brand" to="/artifacts/$artifactId" params={{ artifactId: item.id }}>
                      {item.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
      <div className="hidden h-56 border-t border-border md:block">
        <div className="flex h-9 items-center justify-between px-4 text-[13px]">
          <span className="font-medium">{t('details.logs')}</span>
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <Checkbox checked={following} onCheckedChange={(checked) => setFollowing(checked === true)} />
            {t('details.followEnd')}
          </label>
        </div>
        <div className="h-[184px] overflow-auto bg-background px-4 py-2 font-mono text-[12px]">
          {events.map((event) => (
            <p key={`${event.sequence}-${event.occurredAt}`} className="grid grid-cols-[110px_100px_1fr] gap-3">
              <span className="text-muted-foreground">{formatDateTime(event.occurredAt, locale)}</span>
              <span>{event.type}</span>
              <span>{formatValue(event.payload)}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function nodeLabel(node: WorkflowNodeRunView): string {
  if (node.type === 'worklite/input') return `Workflow input ${node.position}`;
  if (node.type === 'worklite/text') return `Text source ${node.position}`;
  if (node.type === 'worklite/skill-set') return `Skill Set ${node.position}`;
  if (node.type === 'worklite/generic-agent') return `Generic Agent ${node.position}`;
  return `Step ${node.position}`;
}

function nodeProcessor(type: string | undefined): string {
  if (type === 'worklite/generic-agent') return 'Agent model and authorized Skills';
  if (type === 'worklite/input') return 'Workflow input source';
  if (type === 'worklite/skill-set') return 'Skill reference source';
  return type === 'worklite/text' ? 'Text source' : 'Node processor';
}

function toUiStatus(status: WorkflowNodeRunView['status']): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  return status === 'succeeded' ? 'completed' : status;
}

function formatValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
