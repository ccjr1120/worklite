import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AgentRunDetailView, AgentRunView, AgentView } from '@worklite/contracts';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { PageHeading } from '@/components/page-heading';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { ErrorState } from '@/components/error-state';
import { formatTokenCount } from '@/i18n/format';
import { useLocale } from '@/components/locale-provider';
import { cn } from '@/lib/utils';

function RunStatus({ status }: { status: AgentRunView['status'] }) {
  const { t } = useTranslation('agents');
  return <span className={cn('inline-flex shrink-0 rounded-md px-2 py-1 text-xs', status === 'failed' ? 'bg-danger-subtle text-danger' : status === 'running' || status === 'waiting_for_input' ? 'bg-brand-subtle text-brand' : 'bg-surface-subtle text-muted-foreground')}>{t(`statusLabels.${status}`)}</span>;
}

function CopyRunId({ id }: { id: string }) {
  const { t } = useTranslation('agents');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const label = t(state === 'copied' ? 'runIdCopied' : state === 'failed' ? 'copyRunIdFailed' : 'copyRunId');
  return <Button variant="ghost" size="compact" aria-label={label} title={label} onClick={() => { void navigator.clipboard.writeText(id).then(() => setState('copied')).catch(() => setState('failed')); }}>{state === 'copied' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button>;
}

function CurrentActivity({ run }: { run: AgentRunView }) {
  const { t } = useTranslation('agents');
  if (!['running', 'waiting_for_input'].includes(run.status)) return null;
  return <p className="text-sm text-muted-foreground">{run.status === 'waiting_for_input' ? t('statusLabels.waiting_for_input') : run.currentActivity?.phase === 'tool' ? t('currentTool', { tool: run.currentActivity.toolName }) : t('currentModel')}</p>;
}

function TokenUsage({ detail }: { detail: AgentRunDetailView }) {
  const { t } = useTranslation('agents');
  const { locale } = useLocale();
  const tokens = (value: number | null | undefined) => value == null ? t('unrecorded') : formatTokenCount(value, locale);
  const columns = ['inputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'outputTokens', 'totalTokens'] as const;
  const total = (key: typeof columns[number]) => {
    const values = detail.invocations.map((run) => run.usage?.[key]);
    return values.length && values.every((value): value is number => value != null) ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const gateway = detail.gatewayUsage;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('runtimeUsageNote')}</p>
    <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-xs"><thead className="bg-surface-subtle text-muted-foreground"><tr><th className="px-3 py-3 font-medium">Agent</th>{columns.map((key) => <th key={key} className="whitespace-nowrap px-3 py-3 text-right font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{detail.invocations.map((run) => <tr key={run.id}><th scope="row" className="max-w-40 px-3 py-3 font-medium [overflow-wrap:anywhere]">{run.agentName}{run.runtime ? ` · ${run.runtime === 'native' ? t('modelLoop') : run.runtime}` : ''}</th>{columns.map((key) => <td key={key} className="px-3 py-3 text-right tabular-nums">{tokens(run.usage?.[key])}</td>)}</tr>)}</tbody><tfoot className="border-t border-border"><tr><th scope="row" className="px-3 py-3 font-medium">{t('runtimeTotal')}</th>{columns.map((key) => <td key={key} className="px-3 py-3 text-right tabular-nums">{tokens(total(key))}</td>)}</tr></tfoot></table></div>
    <p className="text-xs text-muted-foreground">{t('gatewayUsageNote')}</p>
    {!gateway || gateway.status === 'unavailable' ? <p className="text-xs text-muted-foreground">{t('gatewayUsageUnavailable')}</p> : !gateway.groups.length ? <p className="text-xs text-muted-foreground">{t('gatewayUsageUnrecorded')}</p> : <>
      {gateway.summary && gateway.summary.usageRequests < gateway.summary.requests ? <p className="text-xs text-muted-foreground">{t('gatewayUsagePartial')}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-xs"><thead className="bg-surface-subtle text-muted-foreground"><tr><th className="px-3 py-3 font-medium">Agent</th>{(['freshInputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'outputTokens', 'totalTokens'] as const).map((key) => <th key={key} className="whitespace-nowrap px-3 py-3 text-right font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{gateway.groups.map((group) => <tr key={group.key}><th scope="row" className="max-w-40 px-3 py-3 font-medium [overflow-wrap:anywhere]">{detail.invocations.find((run) => run.id === group.agentRunId)?.agentName ?? group.agentRunId} · {group.executor ?? t('modelLoop')}</th>{[group.promptTokens, group.cacheReadTokens, group.cacheCreationTokens, group.completionTokens, group.totalTokens].map((value, index) => <td key={index} className="px-3 py-3 text-right tabular-nums">{tokens(value)}</td>)}</tr>)}</tbody></table></div>
    </>}
  </div>;
}

export function AgentOverview({ agent, initialRunId, onConfigure }: { agent: AgentView; initialRunId?: string; onConfigure: () => void }) {
  const { t, i18n } = useTranslation('agents');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId ?? null);
  const history = useQuery({ queryKey: ['agent-history', agent.id, offset], queryFn: () => api.agentHistory(agent.id, offset), refetchInterval: 5000 });
  const runId = selectedId ?? history.data?.items[0]?.id;
  const detail = useQuery({ queryKey: ['agent-run', agent.id, runId], queryFn: () => api.agentRun(agent.id, runId!), enabled: !!runId, refetchInterval: 2000 });
  const date = (value: string) => new Date(value).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <div className="mx-auto flex h-full min-h-0 min-w-0 w-full max-w-[1200px] flex-col overflow-hidden px-4 py-6 md:px-6">
    <WorkspaceChrome crumbs={[{ label: t('title'), to: '/agents' }, { label: agent.name }]} />
    <div className="shrink-0"><PageHeading title={agent.name} description={agent.responsibility?.trim() || t('noResponsibility')} actions={<Button variant="secondary" size="compact" onClick={onConfigure}>{t('configure')}</Button>} /></div>
    <section className="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden" aria-labelledby="agent-runs-heading">
      <h2 id="agent-runs-heading" className="mb-4 shrink-0 text-sm font-medium">{t('runs')}</h2>
      {history.isError ? <ErrorState title={t('runs')} description={t('historyFailed')} onAction={() => void history.refetch()} /> : history.isPending ? <p className="py-10 text-sm text-muted-foreground">{t('loading')}</p> : !history.data.items.length ? <p className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">{t('runsEmpty')}</p> : <>
        <div className="grid min-h-0 min-w-0 flex-1 gap-5 overflow-hidden grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_minmax(0,2fr)] lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
          <ul className="h-full min-h-0 min-w-0 divide-y divide-border overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface" aria-label={t('runs')}>
            {history.data.items.map((run) => <li key={run.id} className="min-w-0"><button type="button" aria-pressed={runId === run.id} onClick={() => setSelectedId(run.id)} className={cn('block min-w-0 w-full max-w-full overflow-hidden border-l-2 p-4 text-left transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand', runId === run.id ? 'border-brand bg-surface-subtle' : 'border-transparent')}>
              <span className="mb-3 flex flex-wrap items-center justify-between gap-2"><time dateTime={run.createdAt} className="text-xs text-muted-foreground">{date(run.createdAt)}</time><RunStatus status={run.status} /></span>
              <span className="line-clamp-2 [overflow-wrap:anywhere] text-[13px] leading-6">{run.task || agent.name}</span>
            </button></li>)}
          </ul>
          <div className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-4 md:p-6" aria-live="polite">
            {detail.isError ? <ErrorState title={t('runs')} description={t('runFailed')} onAction={() => void detail.refetch()} /> : !detail.data ? <p className="py-10 text-sm text-muted-foreground">{t('loading')}</p> : <div className="space-y-7">
              <div className="flex items-center justify-between gap-3"><div className="min-w-0"><CurrentActivity run={detail.data.run} /></div><div className="flex shrink-0 items-center gap-2"><CopyRunId key={detail.data.run.id} id={detail.data.run.id} /><RunStatus status={detail.data.run.status} />{!detail.data.run.parentRunId && !detail.data.run.id.startsWith('atc_') && !['running', 'waiting_for_input'].includes(detail.data.run.status) ? <Button asChild variant="secondary" size="compact"><Link to="/chat" search={{ view: 'conversation', agentId: agent.id, agentRunId: detail.data.run.id, agentExecutionId: detail.data.run.executionId }}>{t('continueInChat')}</Link></Button> : null}</div></div>
              {detail.data.run.error ? <p role="alert" className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-danger">{detail.data.run.error}</p> : null}
              <details key={detail.data.run.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{t('task')}</summary><p className="mt-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-6">{detail.data.run.task || agent.name}</p></details>
              <section aria-labelledby="agent-invocations-heading"><h3 id="agent-invocations-heading" className="mb-3 text-sm font-medium">{t('invocations')}</h3><div className="divide-y divide-border rounded-lg border border-border">{detail.data.invocations.map((run) => <details key={run.id} open={['running', 'waiting_for_input'].includes(run.status) || undefined} className="group px-3 py-3"><summary className="cursor-pointer text-[13px]"><span className="ml-2 inline-flex max-w-full flex-wrap items-center gap-3 font-medium [overflow-wrap:anywhere]">{run.agentName}<RunStatus status={run.status} /><time className="text-xs font-normal text-muted-foreground" dateTime={run.createdAt}>{date(run.createdAt)}</time></span></summary><div className="mt-4 min-w-0 space-y-3 overflow-hidden [overflow-wrap:anywhere]"><CurrentActivity run={run} /><p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-6">{run.task}</p>{run.error ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm text-danger">{run.error}</p> : null}</div></details>)}</div></section>
              <section aria-labelledby="agent-outputs-heading"><h3 id="agent-outputs-heading" className="mb-3 text-sm font-medium">{t('outputs')}</h3>{detail.data.artifacts.length ? <ul className="mb-4 space-y-2">{detail.data.artifacts.map((artifact) => <li key={artifact.id}><a href={`/api/artifact-previews/${encodeURIComponent(artifact.id)}/open`} target="_blank" rel="noopener noreferrer" className="text-sm text-brand hover:underline">{artifact.name}</a></li>)}</ul> : null}{!detail.data.artifacts.length ? <p className="text-[13px] text-muted-foreground">{t('noOutputs')}</p> : null}</section>
              <section aria-labelledby="agent-usage-heading"><h3 id="agent-usage-heading" className="mb-3 text-sm font-medium">{t('usage')}</h3>
                <TokenUsage detail={detail.data} />
              </section>
            </div>}
          </div>
        </div>
        {offset > 0 || history.data.hasMore ? <div className="mt-4 flex shrink-0 items-center gap-2"><Button variant="secondary" size="compact" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 20)); setSelectedId(null); }}>{t('previous')}</Button><Button variant="secondary" size="compact" disabled={!history.data.hasMore} onClick={() => { setOffset(offset + 20); setSelectedId(null); }}>{t('next')}</Button></div> : null}
      </>}
    </section>
  </div>;
}
