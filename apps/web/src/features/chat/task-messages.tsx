import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useContext, useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, LoaderCircle, Pause, Play, RefreshCw, RotateCcw, Square, Users } from 'lucide-react';
import type { AgentTeamPendingInputView, AgentTeamRunView, ChatSubmissionView } from '@worklite/contracts';
import { agentTeamGroupQueryKey, agentTeamRunQueryKey, useAgentTeamRunQuery, useRunQuery, useWorkliteUpgradeQuery } from '@/api/queries';
import { TaskLink } from './records';
import { PinTrackingContext } from './pinned-executions';
import { MessageResponse } from '@/components/ai-elements/message';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { StatusBadge, StatusDot, toStatusKey } from '@/components/status-badge';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { TruncatedText } from '@/components/ui/truncated-text';
import { toSingleLine } from '@/lib/single-line';
import { cn } from '@/lib/utils';
import { runModeLabel } from '@/features/agent-teams/run-mode';
import { formatElapsed, isSettledTeamRun, teamCurrentLabel, teamRoleLabel } from '@/features/agent-teams/team-run-summary';

function WorkflowTask({ submission }: { submission: ChatSubmissionView }) {
  const { t } = useTranslation('assistant');
  const reference = submission.reference;
  const query = useRunQuery('personal', reference?.kind === 'workflow' ? reference.runId : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function cancel() {
    if (!query.data || busy) return;
    setBusy(true); setError('');
    try { queryClient.setQueryData(['run', query.data.id], await api.cancelRun('personal', query.data.id)); }
    catch { setError(t('records.cancelFailed')); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    <TaskLink reference={reference} />
    {query.data ? <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-muted-foreground"><StatusBadge key={query.data.status} status={toStatusKey(query.data.status)} label={t(`status.${query.data.status}`)} /><TruncatedText text={`${query.data.workflowName}${query.data.currentStep ? ` · ${query.data.currentStep}` : ''}`} /></div> : null}
    {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
    {query.data && ['queued', 'running', 'paused', 'waiting_for_input'].includes(query.data.status) ? <Button variant="secondary" size="compact" onClick={() => void cancel()} disabled={busy}>{busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" /> : null}{t('records.cancelTask')}</Button> : null}
    {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    {typeof submission.renderedCard?.content === 'string' ? <TruncatedText as="p" text={toSingleLine(submission.renderedCard.content)} title={submission.renderedCard.content} className="text-[13px]" /> : null}
  </div>;
}

function TeamPendingInput({ run, pendingInput, onRunUpdate }: { run: AgentTeamRunView; pendingInput: AgentTeamPendingInputView; onRunUpdate: (run: AgentTeamRunView) => void }) {
  const { t } = useTranslation('assistant');
  const { t: tTeams } = useTranslation('agentTeams');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await api.answerAgentTeamRun(run.id, {
        pendingInputId: pendingInput.id,
        scopeRevision: pendingInput.scopeRevision,
        answer,
      });
      onRunUpdate(response.run);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tTeams('input.answerFailed')); }
    finally { setBusy(false); }
  }

  return <form className="rounded-lg border border-border p-3" onSubmit={(event) => void submit(event)}>
    <MessageResponse content={pendingInput.question} enabled />
    <div className="mt-3 space-y-3">
      <Field label={tTeams('input.answer')} htmlFor={`chat-team-answer-${pendingInput.id}`}><Textarea id={`chat-team-answer-${pendingInput.id}`} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={tTeams('input.answerPlaceholder')} /></Field>
      <Button type="submit" size="compact" disabled={busy}>{busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}{busy ? tTeams('input.answering') : tTeams('input.answer')}</Button>
      {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
    </div>
  </form>;
}

function TeamRunActions({ run, groupId, onRunUpdate }: { run: AgentTeamRunView; groupId?: string; onRunUpdate: (run: AgentTeamRunView) => void }) {
  const { t } = useTranslation('agentTeams');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [reexecutedRunId, setReexecutedRunId] = useState('');
  const active = ['queued', 'running', 'waiting_for_input'].includes(run.status);

  async function perform(key: string, action: () => Promise<{ run: AgentTeamRunView }>) {
    if (busy) return;
    setBusy(key); setError('');
    try { onRunUpdate((await action()).run); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('controls.failed')); }
    finally { setBusy(''); }
  }

  async function reexecute() {
    if (!groupId || busy || reexecutedRunId) return;
    setBusy('reexecute'); setError('');
    try {
      const group = await api.controlAgentTeamGroup(groupId, { operation: 'reexecute', runIds: [run.id] });
      const createdRun = [...group.runs].filter((item) => item.id !== run.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (createdRun) setReexecutedRunId(createdRun.id);
      queryClient.setQueryData(agentTeamGroupQueryKey(groupId), group);
      void queryClient.invalidateQueries({ queryKey: ['agent-team-records', run.teamId] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('controls.failed')); }
    finally { setBusy(''); }
  }

  return <div className="flex flex-wrap items-center justify-end gap-2">
      {active ? <>
        {run.desiredControlState !== 'pause_requested' ? <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('pause', () => api.pauseAgentTeamRun(run.id))}><Pause className="size-3.5" aria-hidden="true" />{t('controls.pause')}</Button> : null}
        <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('cancel', () => api.cancelAgentTeamRun(run.id))}><Square className="size-3.5" aria-hidden="true" />{t('controls.cancel')}</Button>
      </> : run.status === 'paused' ? <>
        <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('resume', () => api.resumeAgentTeamRun(run.id))}><Play className="size-3.5" aria-hidden="true" />{t('controls.resume')}</Button>
        <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('cancel', () => api.cancelAgentTeamRun(run.id))}><Square className="size-3.5" aria-hidden="true" />{t('controls.cancel')}</Button>
      </> : null}
      {groupId && ['succeeded', 'failed', 'cancelled'].includes(run.status) && !reexecutedRunId ? <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void reexecute()}><RefreshCw className="size-3.5" aria-hidden="true" />{t('controls.reexecute')}</Button> : null}
    {run.tasks.filter((task) => task.status === 'failed' && task.retryable).map((task) => <Button key={task.taskKey} type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform(`retry:${task.taskKey}`, () => api.retryAgentTeamTask(run.id, task.taskKey))}><RotateCcw className="size-3.5" aria-hidden="true" />{t('tasks.retryTask', { taskKey: task.taskKey })}</Button>)}
    {reexecutedRunId ? <Link to="/agent-team-runs/$runId" params={{ runId: reexecutedRunId }} className="text-[13px] text-brand-text underline underline-offset-4">{t('run.detail.title')}</Link> : null}
    {error ? <p className="basis-full text-right text-[13px] text-danger" role="alert">{error}</p> : null}
  </div>;
}

function TeamOperationRecovery({ run, operation, onRunUpdate }: { run: AgentTeamRunView; operation: AgentTeamRunView['operations'][number]; onRunUpdate: (run: AgentTeamRunView) => void }) {
  const { t } = useTranslation('agentTeams');
  const [decision, setDecision] = useState<'adopt_command' | 'mark_failed' | 'replay'>('adopt_command');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { onRunUpdate((await api.recoverAgentTeamOperation(run.id, operation.operationKey, { operationKey: operation.operationKey, decision })).run); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('recovery.failed')); }
    finally { setBusy(false); }
  }
  return <form onSubmit={(event) => void submit(event)} className="rounded-lg border border-border p-3">
    <p className="text-sm font-medium">{t('recovery.title')} · {operation.operationKey}</p>
    {operation.failureReason ? <p className="mt-1 text-[13px] text-danger">{operation.failureReason}</p> : null}
    <label className="mt-3 block space-y-1 text-[13px]"><span>{t('recovery.decision')}</span><select className="h-9 w-full rounded-md border border-border bg-surface px-2" value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="adopt_command">{t('recovery.adopt_command')}</option><option value="mark_failed">{t('recovery.mark_failed')}</option><option value="replay">{t('recovery.replay')}</option></select></label>
    <Button type="submit" size="compact" className="mt-3" disabled={busy}>{busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" /> : null}{t('recovery.submit')}</Button>
    {error ? <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p> : null}
  </form>;
}

// Mirrors the project task card: a one-line summary (goal, status, phase and current role) and
// a footer with the role's model and elapsed time; task-level evidence stays collapsed. Pending
// questions and recovery decisions stay visible because the Run is blocked on them.
function TeamRunCard({ submission, runId, groupId }: { submission: ChatSubmissionView; runId: string; groupId?: string }) {
  const { t } = useTranslation('assistant');
  const { t: tTeams } = useTranslation('agentTeams');
  const pins = useContext(PinTrackingContext);
  const query = useAgentTeamRunQuery('personal', runId);
  const run = query.data;
  const [expanded, setExpanded] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const live = run ? !isSettledTeamRun(run) : !submission.settled && !submission.error;
  const expandRequest = pins?.expandRequest;
  useEffect(() => {
    if (expandRequest?.id === submission.id) setExpanded(true);
  }, [expandRequest, submission.id]);
  useEffect(() => {
    if (!live) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [live, runId]);
  function onRunUpdate(updated: AgentTeamRunView) {
    queryClient.setQueryData(agentTeamRunQueryKey(updated.id), updated);
    void queryClient.invalidateQueries({ queryKey: ['agent-team-records', updated.teamId] });
  }
  const failure = run?.status === 'failed' ? [...run.tasks].reverse().find((task) => task.status === 'failed')?.error : null;
  const questions = run?.pendingInputs.filter((input) => input.status === 'pending' && input.kind === 'question') ?? [];
  const recoveries = run?.pendingInputs.filter((input) => input.status === 'pending' && input.kind === 'operation_recovery') ?? [];
  const current = run && live ? run.current : null;
  const runEndMs = run && !live ? Date.parse(run.finishedAt ?? run.updatedAt) : clockNow;
  const totalElapsed = run ? formatElapsed(t, run.createdAt, runEndMs) : null;
  const roleElapsed = current && current.activeCount === 1 ? formatElapsed(t, current.startedAt, clockNow) : null;
  const phase = run && live ? `${tTeams(`progress.phaseValue.${run.progress.phase}`)} · ${tTeams('progress.percent', { percent: run.progress.percent })}` : null;
  const progressLine = current?.progressText.trim() ? toSingleLine(current.progressText) : current?.assignmentTitle ?? null;
  const assignments = run && live && run.progress.totalAssignments > 0 ? tTeams('progress.assignments', { completed: run.progress.completedAssignments, total: run.progress.totalAssignments }) : null;
  const meta = [
    current ? teamCurrentLabel(t, tTeams, current) : run && live ? t('teamRun.betweenRoles') : null,
    current ? current.model || t('teamRun.defaultModel') : null,
    roleElapsed ? t('teamRun.roleElapsed', { duration: roleElapsed }) : null,
    assignments,
    totalElapsed ? t('teamRun.totalElapsed', { duration: totalElapsed }) : null,
  ].filter((part): part is string => Boolean(part));
  const statusKey = submission.error ? 'failed' : run ? toStatusKey(run.status) : 'queued';
  const detailsId = `team-run-details-${submission.id}`;

  return <article
    ref={pins?.track(submission.id)}
    tabIndex={-1}
    className={cn('wl-enter my-2 overflow-hidden rounded-lg border bg-surface shadow-xs transition-[border-color,box-shadow] duration-[200ms] outline-none', live && run ? 'border-brand/40 wl-live-glow' : statusKey === 'failed' ? 'border-danger/30' : 'border-border')}
    aria-label={t('teamRun.panel')}
  >
    <button
      type="button"
      className={cn('flex min-h-11 w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-subtle/70', surfaceInteraction, focusRingInset)}
      aria-expanded={expanded}
      aria-controls={detailsId}
      aria-label={expanded ? t('teamRun.collapse') : t('teamRun.expand')}
      onClick={() => setExpanded((value) => !value)}
    >
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-subtle"><Users className="size-3.5 text-muted-foreground" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1">
        <TruncatedText text={toSingleLine(submission.message)} title={submission.message} className="block text-[13px] font-semibold" />
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <StatusBadge key={statusKey} status={statusKey} label={t(`status.${submission.error ? 'failed' : run?.status ?? 'queued'}`)} />
          {phase ? <span className="shrink-0 tabular-nums">{phase}</span> : null}
          {progressLine ? <TruncatedText text={progressLine} title={current?.progressText || progressLine} /> : null}
        </span>
      </span>
      <ChevronDown className={cn('mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-[200ms] ease-[var(--ease-out)]', !expanded && '-rotate-90')} aria-hidden="true" />
    </button>
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
        {meta.map((part, index) => <span key={index} className={cn('flex min-w-0 items-center gap-1.5', index > 1 && 'shrink-0')}>{index ? <span aria-hidden="true">·</span> : null}<TruncatedText text={part} /></span>)}
        {!run && query.isPending ? <span role="status">{t('records.taskLoading')}</span> : null}
      </p>
      {run ? <TeamRunActions run={run} groupId={groupId} onRunUpdate={onRunUpdate} /> : null}
    </div>
    {submission.error || query.isError || failure || questions.length || recoveries.length ? <div className="space-y-2 border-t border-border px-3 py-2.5">
      {submission.error ? <TruncatedText as="p" text={toSingleLine(submission.error)} title={submission.error} className="text-[13px] text-danger" role="alert" /> : null}
      {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
      {failure ? <TruncatedText as="p" text={toSingleLine(failure)} title={failure} className="text-[13px] text-danger" role="alert" /> : null}
      {run ? questions.map((question) => <TeamPendingInput key={question.id} run={run} pendingInput={question} onRunUpdate={onRunUpdate} />) : null}
      {run ? recoveries.map((pending) => {
        const operation = run.operations.find((item) => item.operationKey === pending.operationKey);
        if (!operation) return null;
        return <TeamOperationRecovery key={operation.operationKey} run={run} operation={operation} onRunUpdate={onRunUpdate} />;
      }) : null}
    </div> : null}
    {expanded ? <div id={detailsId} className="wl-fade space-y-3 border-t border-border px-3 pb-3 pt-2.5 text-[13px]">
      {run && (run.teamVersion.orchestrationVersion ?? 1) >= 10 ? <TruncatedText as="p" text={`${runModeLabel(tTeams, run.mode, 10, run.modeDecidedAt)}${run.modeRationale ? ` · ${toSingleLine(run.modeRationale)}` : ''}`} className="text-muted-foreground" /> : null}
      {run?.outcome ? <MessageResponse content={run.outcome.summary} enabled /> : null}
      {run?.outcome?.unresolvedIssues.map((issue) => <TruncatedText key={issue} as="p" text={toSingleLine(issue)} title={issue} className="text-warning" />)}
      {run?.tasks.length ? <section className="space-y-1.5">
        <h3 className="text-xs font-medium">{t('teamRun.tasks')}</h3>
        <ol className="space-y-1">
          {run.tasks.map((task) => {
            const elapsed = formatElapsed(t, task.startedAt ?? task.createdAt, task.finishedAt ? Date.parse(task.finishedAt) : clockNow);
            return <li key={task.id} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot status={toStatusKey(task.status)} label={t(`status.${task.status}`)} />
              <TruncatedText text={[teamRoleLabel(tTeams, task), task.assignmentTitle ?? task.taskKey, task.model, elapsed].filter(Boolean).join(' · ')} />
            </li>;
          })}
        </ol>
      </section> : null}
      {typeof submission.renderedCard?.content === 'string' ? <TruncatedText as="p" text={toSingleLine(submission.renderedCard.content)} title={submission.renderedCard.content} /> : null}
      <Link to="/agent-team-runs/$runId" params={{ runId }} className="inline-block text-brand-text underline underline-offset-4">{t('teamRun.openRun')}</Link>
    </div> : null}
  </article>;
}

function UpgradeTask({ jobId }: { jobId: string }) {
  const { t } = useTranslation('assistant');
  const query = useWorkliteUpgradeQuery(jobId);
  const job = query.data;
  const statuses: Record<string, string> = {
    proposed: t('upgrade.phase.proposed'), authorized: t('upgrade.phase.authorized'),
    preflighting: t('upgrade.phase.preflighting'), draining: t('upgrade.phase.draining'),
    frozen: t('upgrade.phase.frozen'), switching: t('upgrade.phase.switching'),
    recovering: t('upgrade.phase.recovering'), succeeded: t('upgrade.phase.succeeded'),
    rolled_back: t('upgrade.phase.rolled_back'), failed: t('upgrade.phase.failed'),
  };
  const active = job && !['proposed', 'succeeded', 'rolled_back', 'failed'].includes(job.phase);
  return <div className="space-y-2">
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status">
      {active || query.isLoading ? <LoaderCircle className="size-3.5 shrink-0 text-brand motion-safe:animate-spin" aria-hidden="true" /> : null}
      {t('upgrade.title')} · {job ? statuses[job.phase] ?? job.phase : t('upgrade.loading')}
    </p>
    {job ? <p className="break-all font-mono text-xs text-muted-foreground">{t('upgrade.version', { version: job.releaseHash.slice(0, 12) })}</p> : null}
    {query.isError ? <p className="text-[13px] text-muted-foreground" role="status">{t(job ? 'upgrade.reconnecting' : 'upgrade.loadFailed')}</p> : null}
    {job?.error ? <TruncatedText as="p" text={toSingleLine(job.error)} title={job.error} className="text-[13px] text-danger" role="alert" /> : null}
  </div>;
}

// One task card at its own place in the chronological transcript. Its element is tracked so the
// pinned bar can list it while the task is unfinished and scrolled out of view.
export function TaskCard({ submission }: { submission: ChatSubmissionView }) {
  const { t } = useTranslation('assistant');
  const pins = useContext(PinTrackingContext);
  if (submission.reference?.kind === 'team') return <TeamRunCard submission={submission} runId={submission.reference.runId} groupId={submission.reference.groupId} />;
  return <section ref={pins?.track(submission.id)} tabIndex={-1} className="wl-enter my-4 space-y-3 rounded-xl border border-border bg-surface p-4 shadow-xs outline-none"><TruncatedText as="p" text={toSingleLine(submission.message)} title={submission.message} className="text-sm" />{submission.error ? <div className="space-y-2"><StatusBadge status="failed" label={t('status.failed')} /><TruncatedText as="p" text={toSingleLine(submission.error)} title={submission.error} className="text-[13px] text-danger" role="alert" /></div> : null}{submission.reference?.kind === 'workflow' ? <WorkflowTask submission={submission} /> : submission.reference?.kind === 'upgrade' ? <UpgradeTask jobId={submission.reference.jobId} /> : typeof submission.renderedCard?.content === 'string' ? <TruncatedText as="p" text={toSingleLine(submission.renderedCard.content)} title={submission.renderedCard.content} className="text-[13px]" /> : null}</section>;
}
