import { Fragment, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentTeamRunNode, AgentTeamRunNodeStep, TokenAttribution } from '@worklite/contracts';
import { useLocale } from '@/components/locale-provider';
import { StatusDot, toStatusKey } from '@/components/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { focusRing } from '@/components/ui/interaction';
import { formatDuration, formatNumber, formatTokenCount } from '@/i18n/format';
import { teamRoleLabel } from './coder-run-summary';

/**
 * A token figure with its source. Figures are shortened (12.3k); the tooltip carries the
 * precise count. Exact figures read plainly, estimates carry a "≈" and unavailable figures
 * show a dash, never 0; the reason is in the tooltip.
 */
export function TokenFigure({ value, retentionHours = 12, className = '' }: { value: TokenAttribution; retentionHours?: number; className?: string }) {
  const { t } = useTranslation('coders');
  const { locale } = useLocale();
  const text = value.tokens === null ? '—' : `${value.source === 'estimated' ? '≈' : ''}${formatTokenCount(value.tokens, locale)}`;
  const exact = value.tokens === null ? null : formatNumber(value.tokens, locale);
  const source = t(`tokens.source.${value.source}` as never);
  const sourceHint = value.reason ? `${source}：${t(`tokens.reason.${value.reason}` as never, { hours: retentionHours })}` : source;
  const hint = [exact, sourceHint].filter(Boolean).join(' · ');
  // The hint is also in screen-reader text, because the figure can sit inside a row
  // button or link where a focusable tooltip trigger would be nested interactive content.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`cursor-help tabular-nums ${value.source === 'exact' ? '' : 'text-muted-foreground'} ${className}`}>
          <span aria-hidden="true">{text}</span>
          <span className="sr-only">{`${text}，${hint}`}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function durationText(value: number | null): string {
  return value === null ? '—' : formatDuration(value);
}

const nodeGrid = 'grid grid-cols-[minmax(0,1fr)_6rem_5rem] items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,14rem)_7rem_5rem_6rem_minmax(0,1fr)]';

function RunNodeSteps({ node }: { node: AgentTeamRunNode }) {
  const { t } = useTranslation('coders');
  if (!node.steps.length) return <p className="px-3 py-2 text-xs text-muted-foreground">{t('nodes.noSteps')}</p>;
  return (
    <div className="px-3 pb-2">
      {node.stepsOmitted > 0 ? <p className="py-1 text-xs text-muted-foreground">{t('nodes.stepsOmitted', { count: node.stepsOmitted })}</p> : null}
      <ol className="divide-y divide-border rounded-md border border-border bg-surface-subtle">
        {node.steps.map((step: AgentTeamRunNodeStep) => (
          <li key={step.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)_4rem] items-center gap-2 px-2 py-1.5 text-xs">
            <span className="text-muted-foreground">{t(`nodes.stepKind.${step.kind}` as never)}</span>
            <TruncatedText text={step.label} title={step.label} className="font-mono" />
            <span className="text-right tabular-nums text-muted-foreground">{durationText(step.durationMs)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One row per node (role task attempt) of a Run; a node expands into its steps. */
export function RunNodeTable({ nodes, loading, retentionHours = 12, compact = false }: { nodes: AgentTeamRunNode[] | undefined; loading?: boolean; retentionHours?: number; compact?: boolean }) {
  const { t } = useTranslation('coders');
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  if (loading && !nodes) return <div className="space-y-2 p-3" role="status" aria-busy="true"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>;
  if (!nodes?.length) return <p className="px-3 py-3 text-xs text-muted-foreground">{t('nodes.empty')}</p>;
  if (compact) return <section aria-label={t('nodes.title')} className="divide-y divide-border text-xs">{nodes.map((node) => <div key={node.nodeRunId} className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_6rem] items-center gap-2 px-3 py-2"><span className="truncate">{teamRoleLabel(t, node)}</span><span><StatusDot status={toStatusKey(node.status)} /> {t(`run.status.${node.status}` as never)}</span><span className="text-right">{durationText(node.durationMs)}</span><span className="text-right"><TokenFigure value={node.tokens} retentionHours={retentionHours} /></span></div>)}</section>;
  const isOpen = (node: AgentTeamRunNode) => openNodes[node.nodeRunId] ?? ['running', 'waiting_for_input', 'waiting_for_recovery'].includes(node.status);
  const toggle = (node: AgentTeamRunNode) => setOpenNodes((current) => ({ ...current, [node.nodeRunId]: !isOpen(node) }));
  return (
    <section aria-label={t('nodes.title')} className="text-xs">
      <div aria-hidden="true" className={`${nodeGrid} border-b border-border font-medium text-muted-foreground`}>
        <span>{t('nodes.columns.node')}</span>
        <span>{t('nodes.columns.status')}</span>
        <span className="text-right">{t('nodes.columns.duration')}</span>
        <span className="hidden text-right sm:block">{t('nodes.columns.tokens')}</span>
        <span className="hidden sm:block">{t('nodes.columns.action')}</span>
      </div>
      {nodes.map((node) => {
        const open = isOpen(node);
        const role = teamRoleLabel(t, node);
        return (
          <Fragment key={node.nodeRunId}>
            <button
              type="button"
              aria-expanded={open}
            onClick={() => toggle(node)}
              className={`${nodeGrid} w-full border-b border-border text-left last:border-b-0 hover:bg-muted ${focusRing}`}
            >
              <span className="flex min-w-0 items-center gap-1">
                <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <TruncatedText text={node.name} title={node.name} className="font-medium" />
                  <span className="truncate text-muted-foreground">{node.name === role ? t('nodes.attempt', { index: node.attemptIndex + 1 }) : `${role} · ${t('nodes.attempt', { index: node.attemptIndex + 1 })}`}</span>
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                <StatusDot status={toStatusKey(node.status)} />
                <span className="truncate">{t(`run.status.${node.status}` as never)}</span>
              </span>
              <span className="text-right tabular-nums text-muted-foreground">{durationText(node.durationMs)}</span>
              <span className="hidden text-right sm:block"><TokenFigure value={node.tokens} retentionHours={retentionHours} /></span>
              <span className="hidden min-w-0 sm:block">
                <TruncatedText text={node.latestActivity ?? '—'} title={node.latestActivity ?? undefined} className="text-muted-foreground" />
              </span>
            </button>
          {open ? <RunNodeSteps node={node} /> : null}
          </Fragment>
        );
      })}
    </section>
  );
}
