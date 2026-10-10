import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useContext, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ChatSubmissionView } from '@worklite/contracts';
import { useAgentTeamConversationQuery, useAgentTeamRunQuery, useRunQuery, useWorkliteUpgradeQuery } from '@/api/queries';
import { TaskLink } from './records';
import { PinTrackingContext } from './pinned-executions';
import { MessageResponse } from '@/components/ai-elements/message';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { StatusBadge, toStatusKey } from '@/components/status-badge';

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

function TeamRunLink({ runId }: { runId: string }) {
  const { t } = useTranslation('assistant');
  const query = useAgentTeamRunQuery('personal', runId);
  const run = query.data;
  const failure = run?.status === 'failed' ? [...run.tasks].reverse().find((task) => task.status === 'failed')?.error : null;
  const questions = run?.pendingInputs.filter((input) => input.status === 'pending') ?? [];
  return <div className="space-y-2">
    <Link to="/agent-team-runs/$runId" params={{ runId }} className="text-[13px] text-brand-text underline underline-offset-4">{t('records.openTask')}</Link>
    {run ? <div><StatusBadge key={run.status} status={toStatusKey(run.status)} label={t(`status.${run.status}`)} /></div> : query.isPending ? <p className="text-[13px] text-muted-foreground" role="status">{t('records.taskLoading')}</p> : null}
    {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
    {failure ? <p className="whitespace-pre-wrap break-words text-[13px] text-danger" role="alert">{failure}</p> : null}
    {questions.map((question) => <div key={question.id} className="text-[13px]" role="status"><MessageResponse content={question.question} enabled /></div>)}
  </div>;
}

function TeamTask({ submission }: { submission: ChatSubmissionView }) {
  const { t } = useTranslation('assistant');
  const reference = submission.reference;
  const query = useAgentTeamConversationQuery('personal', reference?.kind === 'team' ? reference.teamId : '');
  const intake = reference?.kind === 'team' ? query.data?.intakes.find((item) => item.submissionId === reference.intakeSubmissionId) : null;
  const question = intake ? query.data?.messages.slice().reverse().find((message) => message.kind === 'coordinator_question' && message.intakeId === intake.id) : null;
  return <div className="space-y-2">
    {intake?.runId ? <TeamRunLink runId={intake.runId} /> : <>
      <TaskLink reference={reference} />
      {intake ? <StatusBadge status={toStatusKey(intake.status === 'collecting' ? 'waiting_for_input' : intake.status)} label={t(`status.${intake.status === 'collecting' ? 'waiting_for_input' : intake.status}`)} /> : query.isPending ? <p className="text-[13px] text-muted-foreground" role="status">{t('records.taskLoading')}</p> : null}
      {intake?.status === 'collecting' && question?.kind === 'coordinator_question' ? <MessageResponse content={question.text} enabled /> : null}
    </>}
    {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
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
