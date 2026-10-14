import { createContext, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatProjectTaskView, ChatSubmissionView, RunView } from '@worklite/contracts';
import { useAgentTeamRunQuery, useRunQuery, useWorkliteUpgradeQuery } from '@/api/queries';
import { isLiveStatus, StatusDot, toStatusKey } from '@/components/status-badge';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { cn } from '@/lib/utils';

type PinTracking = {
  track: (id: string) => (element: HTMLElement | null) => void;
  expandRequest: { id: string; nonce: number } | null;
};

// Cards register their element here so the transcript can tell which unfinished executions the
// reader has scrolled past. The transcript order itself never changes.
export const PinTrackingContext = createContext<PinTracking | null>(null);

export type PinCandidate =
  | { id: string; kind: 'project'; task: ChatProjectTaskView }
  | { id: string; kind: 'submission'; submission: ChatSubmissionView }
  | { id: string; kind: 'workflowRun'; run: RunView; name: string };

const VISIBLE_ROWS = 3;

export function usePinTracking(host: RefObject<HTMLElement | null>) {
  const elements = useRef(new Map<string, HTMLElement>());
  const ids = useRef(new WeakMap<Element, string>());
  const callbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const [above, setAbove] = useState<ReadonlySet<string>>(() => new Set());
  const [expandRequest, setExpandRequest] = useState<PinTracking['expandRequest']>(null);
  const observer = useMemo(() => typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    const top = host.current?.getBoundingClientRect().top ?? 0;
    setAbove((current) => {
      let next: Set<string> | null = null;
      for (const entry of entries) {
        const id = ids.current.get(entry.target);
        if (!id) continue;
        const isAbove = !entry.isIntersecting && entry.boundingClientRect.bottom <= top + 1;
        if (isAbove === current.has(id)) continue;
        next ??= new Set(current);
        if (isAbove) next.add(id);
        else next.delete(id);
      }
      return next ?? current;
    });
  }), [host]);
  useEffect(() => () => observer?.disconnect(), [observer]);

  const track = useCallback((id: string) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        const previous = elements.current.get(id);
        if (previous && previous !== element) {
          observer?.unobserve(previous);
          elements.current.delete(id);
          setAbove((current) => {
            if (!current.has(id)) return current;
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
        if (element && previous !== element) {
          elements.current.set(id, element);
          ids.current.set(element, id);
          observer?.observe(element);
        }
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  }, [observer]);

  const reveal = useCallback((id: string) => {
    const element = elements.current.get(id);
    if (!element) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    element.focus({ preventScroll: true });
    setExpandRequest({ id, nonce: Date.now() });
  }, []);

  const context = useMemo<PinTracking>(() => ({ track, expandRequest }), [track, expandRequest]);
  return { context, above, reveal };
}

export function PinnedExecutionBar({ candidates, above, onReveal }: {
  candidates: PinCandidate[];
  above: ReadonlySet<string>;
  onReveal: (id: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const [live, setLive] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const report = useCallback((id: string, isLive: boolean) => {
    setLive((current) => {
      if (isLive === current.has(id)) return current;
      const next = new Set(current);
      if (isLive) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const scrolledPast = candidates.filter((candidate) => above.has(candidate.id));
  const pinned = scrolledPast.filter((candidate) => live.has(candidate.id));
  const shown = new Set((expanded ? pinned : pinned.slice(0, VISIBLE_ROWS)).map((candidate) => candidate.id));
  const hiddenCount = pinned.length - shown.size;
  useEffect(() => { if (pinned.length <= VISIBLE_ROWS) setExpanded(false); }, [pinned.length]);
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 top-0 z-10 px-4 md:px-8', pinned.length === 0 && 'hidden')}>
      <section aria-label={t('pinned.label')} className="pointer-events-auto mx-auto w-full max-w-3xl overflow-hidden rounded-b-lg border border-t-0 border-border bg-surface shadow-sm">
        <ul className="max-h-60 overflow-y-auto">
          {scrolledPast.map((candidate) => (
            <PinnedRow key={candidate.id} candidate={candidate} visible={shown.has(candidate.id)} onLive={report} onReveal={onReveal} />
          ))}
        </ul>
        {hiddenCount > 0 || expanded ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className={cn('w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground', surfaceInteraction, focusRingInset)}>
            {expanded ? t('pinned.collapse') : t('pinned.more', { count: hiddenCount })}
          </button>
        ) : null}
      </section>
    </div>
  );
}

type RowState = { live: boolean; status: string | null; title: string; progress: string | null };

function PinnedRow({ candidate, visible, onLive, onReveal }: {
  candidate: PinCandidate;
  visible: boolean;
  onLive: (id: string, live: boolean) => void;
  onReveal: (id: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const state = usePinnedRowState(candidate);
  useEffect(() => { onLive(candidate.id, state.live); }, [candidate.id, onLive, state.live]);
  useEffect(() => () => onLive(candidate.id, false), [candidate.id, onLive]);
  if (!visible || !state.live) return null;
  const statusKey = toStatusKey(state.status ?? 'running');
  const statusLabel = t(`status.${state.status ?? 'running'}`, { defaultValue: state.status ?? '' });
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => onReveal(candidate.id)}
        aria-label={t('pinned.reveal', { title: state.title, status: statusLabel })}
        className={cn('flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left', surfaceInteraction, focusRingInset)}
      >
        <StatusDot status={statusKey} />
        <span className="min-w-0 shrink truncate text-[13px] font-medium">{state.title}</span>
        {state.progress ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{state.progress}</span> : <span className="flex-1" />}
      </button>
    </li>
  );
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

// Each kind reads its status from the same queries its card already uses, so the bar adds no request.
function usePinnedRowState(candidate: PinCandidate): RowState {
  const { t } = useTranslation('assistant');
  const reference = candidate.kind === 'submission' ? candidate.submission.reference : null;
  const workflow = useRunQuery('personal', reference?.kind === 'workflow' ? reference.runId : '', reference?.kind === 'workflow');
  const teamRun = useAgentTeamRunQuery('personal', reference?.kind === 'team' ? reference.runId : '');
  const upgrade = useWorkliteUpgradeQuery(reference?.kind === 'upgrade' ? reference.jobId : '');

  if (candidate.kind === 'project') {
    const latest = candidate.task.activities.at(-1);
    const progress = typeof latest?.summary === 'string' ? latest.summary : typeof latest?.phase === 'string' ? latest.phase : null;
    return { live: isLiveStatus(candidate.task.status), status: candidate.task.status, title: firstLine(candidate.task.goal), progress };
  }
  if (candidate.kind === 'workflowRun') {
    return { live: isLiveStatus(candidate.run.status), status: candidate.run.status, title: candidate.name, progress: candidate.run.currentStep };
  }
  const submission = candidate.submission;
  const title = firstLine(submission.message);
  if (submission.error) return { live: false, status: 'failed', title, progress: null };
  if (reference?.kind === 'workflow') {
    const run = workflow.data;
    return { live: run ? isLiveStatus(run.status) : !submission.settled, status: run?.status ?? 'queued', title: run?.workflowName ?? title, progress: run?.currentStep ?? null };
  }
  if (reference?.kind === 'team') {
    if (teamRun.data) return { live: isLiveStatus(teamRun.data.status), status: teamRun.data.status, title, progress: null };
    return { live: !submission.settled, status: 'queued', title, progress: null };
  }
  if (reference?.kind === 'upgrade') {
    const job = upgrade.data;
    const active = job ? !['proposed', 'succeeded', 'rolled_back', 'failed'].includes(job.phase) : !submission.settled;
    return { live: active, status: 'running', title: t('upgrade.title'), progress: job ? t(`upgrade.phase.${job.phase}`, { defaultValue: job.phase }) : null };
  }
  return { live: false, status: null, title, progress: null };
}
