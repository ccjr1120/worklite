import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { ChatSubmissionView } from '@worklite/contracts';
import { useAgentTeamConversationQuery, useAgentTeamRunQuery, useRunQuery } from '@/api/queries';
import { TaskLink } from './records';
import { MessageResponse } from '@/components/ai-elements/message';
import { api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { Button } from '@/components/ui/button';

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
    {query.data ? <p className="text-[13px] text-muted-foreground">{query.data.workflowName} · {t(`status.${query.data.status}`)}{query.data.currentStep ? ` · ${query.data.currentStep}` : ''}</p> : null}
    {query.isError ? <p className="text-[13px] text-danger" role="alert">{t('records.taskLoadFailed')}</p> : null}
    {query.data && ['queued', 'running', 'paused', 'waiting_for_input'].includes(query.data.status) ? <Button variant="secondary" size="compact" onClick={() => void cancel()} disabled={busy}>{busy ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" /> : null}{t('records.cancelTask')}</Button> : null}
    {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    {typeof submission.renderedCard?.content === 'string' ? <MessageResponse content={submission.renderedCard.content} enabled /> : null}
  </div>;
}

function TeamRunLink({ runId }: { runId: string }) {
  const { t } = useTranslation('assistant');
  const query = useAgentTeamRunQuery('personal', runId);
  return <div className="space-y-2"><Link to="/agent-team-runs/$runId" params={{ runId }} className="text-[13px] text-brand underline underline-offset-4">{t('records.openTask')}</Link>{query.data ? <p className="text-[13px] text-muted-foreground">{t(`status.${query.data.status}`)}</p> : null}</div>;
}

function TeamTask({ submission }: { submission: ChatSubmissionView }) {
  const reference = submission.reference;
  const query = useAgentTeamConversationQuery('personal', reference?.kind === 'team' ? reference.teamId : '');
  const intake = reference?.kind === 'team' ? query.data?.intakes.find((item) => item.submissionId === reference.intakeSubmissionId) : null;
  return <div className="space-y-2">{intake?.runId ? <TeamRunLink runId={intake.runId} /> : <TaskLink reference={reference} />}{typeof submission.renderedCard?.content === 'string' ? <MessageResponse content={submission.renderedCard.content} enabled /> : null}</div>;
}

export function TaskMessages({ submissions }: { submissions: ChatSubmissionView[] }) {
  return <>{submissions.filter((submission) => submission.reference && submission.reference.kind !== 'conversation').map((submission) => <section key={submission.id} className="my-4 space-y-3 border-l-2 border-border pl-3"><p className="whitespace-pre-wrap break-words text-sm">{submission.message}</p>{submission.error ? <p className="text-[13px] text-danger" role="alert">{submission.error}</p> : null}{submission.reference?.kind === 'workflow' ? <WorkflowTask submission={submission} /> : submission.reference?.kind === 'team' ? <TeamTask submission={submission} /> : typeof submission.renderedCard?.content === 'string' ? <MessageResponse content={submission.renderedCard.content} enabled /> : null}</section>)}</>;
}
