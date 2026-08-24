import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CopyableId } from '@/components/copyable-id';
import { PageHeading } from '@/components/page-heading';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { durationParts, formatDateTime } from '@/i18n/format';
import { workflowSteps, runs, artifacts } from '@/mock/data';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/$teamSlug/runs/$runId')({
  component: RunDetailsPage,
});

const LOGS = [
  { time: '08:12:01.120', severity: 'info', source: 'run', content: 'Run queued' },
  { time: '08:12:04.448', severity: 'info', source: 'Researcher', content: 'Step started with topic input' },
  { time: '08:13:22.019', severity: 'info', source: 'Researcher', content: 'Retrieved 8 sources' },
  { time: '08:14:11.330', severity: 'info', source: 'Brief writer', content: 'Generating brief' },
];

function RunDetailsPage() {
  const { t } = useTranslation(['runs', 'common']);
  const { locale } = useLocale();
  const { teamSlug, runId } = Route.useParams();
  const run = runs.find((item) => item.id === runId);
  const steps = workflowSteps[run?.workflowId ?? ''] ?? [];
  const [selectedId, setSelectedId] = useState(steps.find((step) => step.status === 'running')?.id ?? steps[0]?.id ?? null);
  const [following, setFollowing] = useState(true);
  const selected = steps.find((step) => step.id === selectedId);
  const runArtifacts = artifacts.filter((item) => item.runId === runId);
  const cancellable = run?.status === 'running' || run?.status === 'queued' || run?.status === 'waiting_for_input';

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
          { label: t('title'), to: `/${teamSlug}/runs` },
          { label: run.workflowName },
        ]}
        actions={
          cancellable ? (
            <Button variant="destructive" size="compact">
              {t('details.cancel')}
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
                <StatusBadge status={run.status} />
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
              <Link className="font-medium underline" to="/$teamSlug/workflows/$workflowId" params={{ teamSlug, workflowId: run.workflowId }}>
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
                      step.status === 'completed' && 'bg-success',
                      step.status === 'failed' && 'bg-danger',
                      step.status === 'running' && 'bg-brand',
                      (!step.status || step.status === 'queued') && 'bg-border',
                    )}
                    aria-hidden="true"
                  />
                  {index < steps.length - 1 ? <span className="w-px flex-1 bg-border" /> : null}
                </div>
                <button type="button" className="mb-4 w-full rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-subtle" onClick={() => setSelectedId(step.id)}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{step.agentName}</span>
                    {step.status ? <StatusBadge status={step.status} /> : null}
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{step.agentVersion}</p>
                </button>
              </li>
            ))}
          </ol>
        </div>
        <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 lg:block">
          <h2 className="text-sm font-semibold">{selected?.agentName ?? t('details.stepFallback')}</h2>
          <dl className="mt-4 space-y-3 text-[13px]">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('details.input')}</dt>
              <dd className="mt-1 font-mono text-xs">{selected?.inputSummary ?? t('common:empty.dash')}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('details.model')}</dt>
              <dd className="mt-1">claude-sonnet-4</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('details.retries')}</dt>
              <dd className="mt-1 tabular-nums">0</dd>
            </div>
          </dl>
          {runArtifacts.length ? (
            <div className="mt-6">
              <h3 className="text-xs font-medium text-muted-foreground">{t('details.artifacts')}</h3>
              <ul className="mt-2 space-y-1">
                {runArtifacts.map((item) => (
                  <li key={item.id}>
                    <Link className="font-mono text-[13px] hover:text-brand" to="/$teamSlug/artifacts/$artifactId" params={{ teamSlug, artifactId: item.id }}>
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
          <label className="flex items-center gap-2 text-muted-foreground">
            <input type="checkbox" checked={following} onChange={(event) => setFollowing(event.target.checked)} />
            {t('details.followEnd')}
          </label>
        </div>
        <div className="h-[184px] overflow-auto bg-background px-4 py-2 font-mono text-[12px]">
          {LOGS.map((line) => (
            <p key={line.time} className="grid grid-cols-[110px_64px_110px_1fr] gap-3">
              <span className="text-muted-foreground">{line.time}</span>
              <span>{line.severity}</span>
              <span className="text-muted-foreground">{line.source}</span>
              <span>{line.content}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
