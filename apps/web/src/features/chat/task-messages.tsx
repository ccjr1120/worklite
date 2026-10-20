import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useContext, useState, type FormEvent } from 'react';
import { LoaderCircle, Pause, Play, RefreshCw, RotateCcw, Square } from 'lucide-react';
import type { AgentTeamPendingInputView, AgentTeamRunView, AgentTeamTaskAttemptView, ChatSubmissionView } from '@worklite/contracts';
import { agentTeamGroupQueryKey, agentTeamRunQueryKey, useAgentTeamRunQuery, useRunQuery, useWorkliteUpgradeQuery } from '@/api/queries';
import { TaskLink } from './records';
import { PinTrackingContext } from './pinned-executions';
import { MessageResponse } from '@/components/ai-elements/message';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

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
    {query.data ? <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-muted-foreground"><StatusBadge key={query.data.status} status={toStatusKey(query.data.status)} label={t(`status.${query.data.status}`)} /><span className="min-w-0 truncate">{query.data.workflowName}{query.data.currentStep ? ` · ${query.data.currentStep}` : ''}</span></div> : null}
    {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
    {query.data && ['queued', 'running', 'paused', 'waiting_for_input'].includes(query.data.status) ? <Button variant="secondary" size="compact" onClick={() => void cancel()} disabled={busy}>{busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" /> : null}{t('records.cancelTask')}</Button> : null}
    {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    {typeof submission.renderedCard?.content === 'string' ? <MessageResponse content={submission.renderedCard.content} enabled /> : null}
  </div>;
}

function TeamPendingInput({ run, pendingInput, owner, onRunUpdate }: { run: AgentTeamRunView; pendingInput: AgentTeamPendingInputView; owner?: AgentTeamTaskAttemptView; onRunUpdate: (run: AgentTeamRunView) => void }) {
  const { t } = useTranslation('assistant');
  const { t: tTeams } = useTranslation('agentTeams');
  const [answer, setAnswer] = useState('');
  const [commands, setCommands] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canGrantCommands = Boolean(owner && run.mode !== 'plan_only' && owner.role !== 'developer' && owner.role !== 'team-manager' && !run.teamVersion.projectExecutorLaunches?.[owner.role]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await api.answerAgentTeamRun(run.id, {
        pendingInputId: pendingInput.id,
        scopeRevision: pendingInput.scopeRevision,
        answer,
        authorizedCommands: canGrantCommands ? commands.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
      });
      onRunUpdate(response.run);
    } catch (cause) { setError(cause instanceof Error ? cause.message : tTeams('input.answerFailed')); }
    finally { setBusy(false); }
  }

  return <form className="rounded-lg border border-border p-3" onSubmit={(event) => void submit(event)}>
    <MessageResponse content={pendingInput.question} enabled />
    <div className="mt-3 space-y-3">
      <Field label={tTeams('input.answer')} htmlFor={`chat-team-answer-${pendingInput.id}`}><Textarea id={`chat-team-answer-${pendingInput.id}`} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={tTeams('input.answerPlaceholder')} /></Field>
      {canGrantCommands ? <Field label={tTeams('input.commands')} htmlFor={`chat-team-commands-${pendingInput.id}`}><Textarea id={`chat-team-commands-${pendingInput.id}`} value={commands} onChange={(event) => setCommands(event.target.value)} placeholder={tTeams('run.commandsPlaceholder')} /></Field> : null}
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

  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {active ? <>
        {run.desiredControlState !== 'pause_requested' ? <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('pause', () => api.pauseAgentTeamRun(run.id))}><Pause className="size-3.5" aria-hidden="true" />{t('controls.pause')}</Button> : null}
        <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('cancel', () => api.cancelAgentTeamRun(run.id))}><Square className="size-3.5" aria-hidden="true" />{t('controls.cancel')}</Button>
      </> : run.status === 'paused' ? <>
        <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('resume', () => api.resumeAgentTeamRun(run.id))}><Play className="size-3.5" aria-hidden="true" />{t('controls.resume')}</Button>
        <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform('cancel', () => api.cancelAgentTeamRun(run.id))}><Square className="size-3.5" aria-hidden="true" />{t('controls.cancel')}</Button>
      </> : null}
      {groupId && ['succeeded', 'failed', 'cancelled'].includes(run.status) && !reexecutedRunId ? <Button type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void reexecute()}><RefreshCw className="size-3.5" aria-hidden="true" />{t('controls.reexecute')}</Button> : null}
    </div>
    {run.tasks.filter((task) => task.status === 'failed' && task.retryable).map((task) => <Button key={task.taskKey} type="button" variant="secondary" size="compact" disabled={Boolean(busy)} onClick={() => void perform(`retry:${task.taskKey}`, () => api.retryAgentTeamTask(run.id, task.taskKey))}><RotateCcw className="size-3.5" aria-hidden="true" />{t('tasks.retryTask', { taskKey: task.taskKey })}</Button>)}
    {reexecutedRunId ? <Link to="/agent-team-runs/$runId" params={{ runId: reexecutedRunId }} className="inline-block text-[13px] text-brand-text underline underline-offset-4">{t('group.openRun')}</Link> : null}
    {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
  </div>;
}

function TeamRunLink({ runId, groupId }: { runId: string; groupId?: string }) {
  const { t } = useTranslation('assistant');
  const { t: tTeams } = useTranslation('agentTeams');
  const query = useAgentTeamRunQuery('personal', runId);
  const run = query.data;
  const failure = run?.status === 'failed' ? [...run.tasks].reverse().find((task) => task.status === 'failed')?.error : null;
  const questions = run?.pendingInputs.filter((input) => input.status === 'pending' && input.kind === 'question') ?? [];
  const recoveries = run?.pendingInputs.filter((input) => input.status === 'pending' && input.kind === 'operation_recovery') ?? [];
  function onRunUpdate(updated: AgentTeamRunView) {
    queryClient.setQueryData(agentTeamRunQueryKey(updated.id), updated);
    void queryClient.invalidateQueries({ queryKey: ['agent-team-records', updated.teamId] });
  }
  return <div className="space-y-2">
    <Link to="/agent-team-runs/$runId" params={{ runId }} className="text-[13px] text-brand-text underline underline-offset-4">{t('records.openTask')}</Link>
    {run ? <div className="flex flex-wrap items-center gap-2">
      <StatusBadge key={run.status} status={toStatusKey(run.status)} label={t(`status.${run.status}`)} />
      {run.progress ? <span className="text-[13px] text-muted-foreground tabular-nums">{tTeams(`progress.phaseValue.${run.progress.phase}`)} · {tTeams('progress.percent', { percent: run.progress.percent })}</span> : null}
    </div> : query.isPending ? <p className="text-[13px] text-muted-foreground" role="status">{t('records.taskLoading')}</p> : null}
    {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
    {failure ? <p className="whitespace-pre-wrap break-words text-[13px] text-danger" role="alert">{failure}</p> : null}
    {run ? <TeamRunActions run={run} groupId={groupId} onRunUpdate={onRunUpdate} /> : null}
    {run ? questions.map((question) => <TeamPendingInput key={question.id} run={run} pendingInput={question} owner={run.tasks.find((task) => task.id === question.taskAttemptId)} onRunUpdate={onRunUpdate} />) : null}
    {run ? recoveries.map((pending) => {
      const operation = run.operations.find((item) => item.operationKey === pending.operationKey);
      if (!operation) return null;
      return <TeamOperationRecovery key={operation.operationKey} run={run} operation={operation} onRunUpdate={onRunUpdate} />;
    }) : null}
    {run?.outcome ? <div className="text-[13px]"><MessageResponse content={run.outcome.summary} enabled /></div> : null}
    {run?.outcome?.unresolvedIssues.map((issue) => <p key={issue} className="text-[13px] text-warning">{issue}</p>)}
    {run?.tasks.filter((task) => task.status === 'running' && task.progressText).map((task) => <div key={task.id} className="text-[13px] text-muted-foreground"><MessageResponse content={task.progressText} enabled /></div>)}
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

function TeamTask({ submission }: { submission: ChatSubmissionView }) {
  const reference = submission.reference;
  return <div className="space-y-2">
    {reference?.kind === 'team' ? <TeamRunLink runId={reference.runId} groupId={reference.groupId} /> : null}
    {typeof submission.renderedCard?.content === 'string' ? <MessageResponse content={submission.renderedCard.content} enabled /> : null}
  </div>;
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
    {job?.error ? <p className="whitespace-pre-wrap break-words text-[13px] text-danger" role="alert">{job.error}</p> : null}
  </div>;
}

// One task card at its own place in the chronological transcript. Its element is tracked so the
// pinned bar can list it while the task is unfinished and scrolled out of view.
export function TaskCard({ submission }: { submission: ChatSubmissionView }) {
  const { t } = useTranslation('assistant');
  const pins = useContext(PinTrackingContext);
  return <section ref={pins?.track(submission.id)} tabIndex={-1} className="wl-enter my-4 space-y-3 rounded-xl border border-border bg-surface p-4 shadow-xs outline-none"><p className="whitespace-pre-wrap break-words text-sm">{submission.message}</p>{submission.error ? <div className="space-y-2"><StatusBadge status="failed" label={t('status.failed')} /><p className="text-[13px] text-danger" role="alert">{submission.error}</p></div> : null}{submission.reference?.kind === 'workflow' ? <WorkflowTask submission={submission} /> : submission.reference?.kind === 'team' ? <TeamTask submission={submission} /> : submission.reference?.kind === 'upgrade' ? <UpgradeTask jobId={submission.reference.jobId} /> : typeof submission.renderedCard?.content === 'string' ? <MessageResponse content={submission.renderedCard.content} enabled /> : null}</section>;
}
