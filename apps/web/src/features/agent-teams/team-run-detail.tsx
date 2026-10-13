import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentTeamCriterionAssessment,
  AgentTeamOperationRecoveryDecision,
  AgentTeamOperationView,
  AgentTeamPendingInputView,
  AgentTeamRunEvent,
  AgentTeamRunProgress,
  AgentTeamRunView,
  AgentTeamTaskAttemptView,
  CommandExecutionEvent,
  CommandExecutionView,
} from '@worklite/contracts';
import { ApiError, api, parseAgentTeamRunEvent, parseCommandEvent } from '@/api/client';
import { agentTeamRunQueryKey, useAgentTeamRunQuery } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyableId } from '@/components/copyable-id';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

type TeamStatus =
  | AgentTeamRunView['status']
  | AgentTeamTaskAttemptView['status']
  | AgentTeamOperationView['status']
  | CommandExecutionView['status'];

const TERMINAL_RUN_STATUSES = new Set<AgentTeamRunView['status']>(['succeeded', 'failed', 'cancelled']);
const RECOVERY_DECISIONS = ['adopt_command', 'mark_failed', 'replay'] as const;
const ROLE_LABELS = {
  planner: 'role.planner',
  test_designer: 'role.test_designer',
  developer: 'role.developer',
  test_author: 'role.test_author',
  test_runner: 'role.test_runner',
  reviewer: 'role.reviewer',
} as const;

const DESIRED_CONTROL_LABELS = {
  none: 'run.desiredControl.none',
  pause_requested: 'run.desiredControl.pause_requested',
  cancel_requested: 'run.desiredControl.cancel_requested',
} as const;

const ASSESSMENT_META: Record<AgentTeamCriterionAssessment['assessment'], { variant: 'success' | 'warning' | 'danger'; icon: typeof CheckCircle2 }> = {
  met: { variant: 'success', icon: CheckCircle2 },
  unmet: { variant: 'danger', icon: XCircle },
  not_verified: { variant: 'warning', icon: CircleHelp },
};

type TaskDeltaPayload = {
  taskAttemptId: string;
  taskKey: string;
  delta: string;
};

type MemberOutputGroup = {
  taskAttemptId: string;
  taskKey: string;
  text: string;
  lastSequence: number;
};

const ACTIVE_ATTEMPT_STATUSES = new Set<AgentTeamTaskAttemptView['status']>(['running', 'waiting_for_input', 'waiting_for_recovery']);

type RunStatusPayload = {
  status: string;
};

// Team statuses keep their own wording but share the product-wide status presentation.
function TeamStatusBadge({ status }: { status: TeamStatus }) {
  const { t } = useTranslation('agentTeams');
  return <StatusBadge key={status} status={toStatusKey(status)} label={t(`run.status.${status}`)} />;
}

function AssessmentBadge({ assessment }: { assessment: AgentTeamCriterionAssessment['assessment'] }) {
  const { t } = useTranslation('agentTeams');
  const meta = ASSESSMENT_META[assessment];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon className="size-3" aria-hidden="true" />
      {t(`outcome.assessment.${assessment}`)}
    </Badge>
  );
}

function commandLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isStatusPayload(payload: unknown): payload is RunStatusPayload {
  return Boolean(payload && typeof payload === 'object' && typeof (payload as RunStatusPayload).status === 'string');
}

function taskDeltaOf(payload: unknown): TaskDeltaPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<TaskDeltaPayload>;
  return typeof candidate.taskAttemptId === 'string'
    && typeof candidate.taskKey === 'string'
    && typeof candidate.delta === 'string'
    ? candidate as TaskDeltaPayload
    : null;
}

function appendDeduplicatedEvent(events: AgentTeamRunEvent[], event: AgentTeamRunEvent): AgentTeamRunEvent[] {
  if (events.some((item) => item.sequence === event.sequence)) return events;
  return [...events, event].sort((left, right) => left.sequence - right.sequence);
}

function appendCommandEvent(events: CommandExecutionEvent[], event: CommandExecutionEvent): CommandExecutionEvent[] {
  if (events.some((item) => item.sequence === event.sequence)) return events;
  return [...events, event].sort((left, right) => left.sequence - right.sequence);
}

function ContentDisclosure({ summary, content, markdown = false }: { summary: string; content: string; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="secondary" size="compact" className="max-w-full justify-start text-left">
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronRight className={cn('ml-auto size-3 transition-transform duration-[120ms]', open && 'rotate-90')} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {markdown ? (
          <div className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-surface-subtle p-3">
            <StreamingMarkdown content={content} className="text-xs leading-5" />
          </div>
        ) : (
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-surface-subtle p-3 font-mono text-xs whitespace-pre-wrap break-words">
            {content}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function MemberOutputGroupView({ group, owner, active }: { group: MemberOutputGroup; owner: AgentTeamTaskAttemptView | undefined; active: boolean }) {
  const { t } = useTranslation('agentTeams');
  const [open, setOpen] = useState(active);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="secondary" size="compact" className="w-full max-w-full justify-start text-left">
          <span className="min-w-0 truncate">
            <span className="font-mono">{group.taskKey}</span>
            {owner ? ` · ${t(ROLE_LABELS[owner.role])}` : ''}
            {owner?.assignmentTitle ? ` · ${owner.assignmentTitle}` : ''}
          </span>
          {active ? <LoaderCircle className="ml-1 size-3 shrink-0 motion-safe:animate-spin" aria-hidden="true" /> : null}
          <ChevronRight className={cn('ml-auto size-3 shrink-0 transition-transform duration-[120ms]', open && 'rotate-90')} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-surface-subtle p-3">
          <StreamingMarkdown content={group.text} streaming={active} className="text-xs leading-5" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunProgressSection({ progress }: { progress: AgentTeamRunProgress }) {  const { t } = useTranslation('agentTeams');
  return (
    <section className="mt-4 rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-run-progress">
      <div className="flex items-center justify-between gap-3">
        <h2 id="agent-team-run-progress" className="text-sm font-semibold">{t('progress.title')}</h2>
        <span className="text-sm font-medium tabular-nums">{t('progress.percent', { percent: progress.percent })}</span>
      </div>
      <Progress value={progress.percent} className="mt-2" />
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <span>{t('progress.phase')}: <span className="font-medium">{t(`progress.phaseValue.${progress.phase}`)}</span></span>
        <span>{t('progress.nextStep')}: <span className="font-medium">{t(`progress.nextStepValue.${progress.nextStep}`)}</span></span>
        {progress.totalAssignments > 0 ? (
          <span className="tabular-nums">{t('progress.assignments', { completed: progress.completedAssignments, total: progress.totalAssignments })}</span>
        ) : null}
        {progress.activeDeveloperIds.length > 0 ? (
          <span className="min-w-0">{t('progress.activeDevelopers')}: <span className="font-mono text-xs break-all">{progress.activeDeveloperIds.join(', ')}</span></span>
        ) : null}
        {progress.waitingReason ? <span className="text-warning">{t(`progress.waitingReason.${progress.waitingReason}`)}</span> : null}
      </div>
    </section>
  );
}

function PendingInputPanel({
  runId,
  pendingInput,
  owner,
  allowCommands,
  onRunUpdate,
}: {
  runId: string;
  pendingInput: AgentTeamPendingInputView;
  owner: AgentTeamTaskAttemptView | undefined;
  allowCommands: boolean;
  onRunUpdate: (run: AgentTeamRunView) => void;
}) {
  const { t } = useTranslation('agentTeams');
  const [answer, setAnswer] = useState('');
  const [authorizedCommands, setAuthorizedCommands] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await api.answerAgentTeamRun(runId, {
        pendingInputId: pendingInput.id,
        scopeRevision: pendingInput.scopeRevision,
        answer,
        authorizedCommands: allowCommands ? commandLines(authorizedCommands) : [],
      });
      onRunUpdate(response.run);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : t('input.answerFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby={`agent-team-question-title-${pendingInput.id}`}>
      <h2 id={`agent-team-question-title-${pendingInput.id}`} className="text-sm font-semibold">{t('input.title')}</h2>
      <StreamingMarkdown content={pendingInput.question} className="mt-2 text-[13px]" />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        {owner ? <span>{t(ROLE_LABELS[owner.role])}</span> : null}
        {owner ? <span className="font-mono text-xs break-all">{owner.taskKey}</span> : null}
        {owner?.assignmentTitle ? <span className="min-w-0 break-all">{owner.assignmentTitle}</span> : null}
        <CopyableId value={pendingInput.id} />
        <span>{t('run.scopeRevision')}: <span className="font-mono tabular-nums">{pendingInput.scopeRevision}</span></span>
      </div>
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <Field label={t('input.answer')} htmlFor={`agent-team-answer-${pendingInput.id}`}>
          <Textarea
            id={`agent-team-answer-${pendingInput.id}`}
            value={answer}
            placeholder={t('input.answerPlaceholder')}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </Field>
        {allowCommands ? <Field label={t('input.commands')} htmlFor={`agent-team-answer-commands-${pendingInput.id}`}>
          <Textarea
            id={`agent-team-answer-commands-${pendingInput.id}`}
            className="min-h-20"
            value={authorizedCommands}
            placeholder={t('run.commandsPlaceholder')}
            onChange={(event) => setAuthorizedCommands(event.target.value)}
          />
        </Field> : null}
        <div className="flex flex-col gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
            {submitting ? t('input.answering') : t('input.answer')}
          </Button>
          {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
        </div>
      </form>
    </section>
  );
}

function OperationRecoveryPanel({
  runId,
  operation,
  pendingInput,
  onRunUpdate,
}: {
  runId: string;
  operation: AgentTeamOperationView;
  pendingInput: AgentTeamPendingInputView | null;
  onRunUpdate: (run: AgentTeamRunView) => void;
}) {
  const { t } = useTranslation('agentTeams');
  const [decision, setDecision] = useState<AgentTeamOperationRecoveryDecision['type']>('adopt_command');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await api.recoverAgentTeamOperation(runId, operation.operationKey, {
        operationKey: operation.operationKey,
        decision,
      });
      onRunUpdate(response.run);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : t('recovery.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby={`operation-recovery-${operation.operationKey}`}>
      <h2 id={`operation-recovery-${operation.operationKey}`} className="text-sm font-semibold">{t('recovery.title')}</h2>
      {pendingInput ? <StreamingMarkdown content={pendingInput.question} className="mt-2 text-[13px]" /> : null}
      <dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('recovery.operation')}</dt>
          <dd className="mt-1"><CopyableId value={operation.operationKey} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('metadata.status')}</dt>
          <dd className="mt-1"><TeamStatusBadge status={operation.status} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('metadata.taskKey')}</dt>
          <dd className="mt-1 font-mono break-all">{operation.taskKey}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('operations.command')}</dt>
          <dd className="mt-1 font-mono break-all">{operation.commandId ?? t('operations.noCommand')}</dd>
        </div>
      </dl>
      {operation.failureReason ? <p className="mt-3 text-[13px] text-danger" role="alert">{operation.failureReason}</p> : null}
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <fieldset>
          <legend id={`operation-recovery-decision-${operation.operationKey}`} className="text-xs font-medium text-foreground">{t('recovery.decision')}</legend>
          <RadioGroup
            aria-labelledby={`operation-recovery-decision-${operation.operationKey}`}
            className="mt-2"
            value={decision}
            onValueChange={(value) => setDecision(value as AgentTeamOperationRecoveryDecision['type'])}
          >
            {RECOVERY_DECISIONS.map((item) => (
              <label key={item} className="flex items-center gap-2 text-[13px]">
                <RadioGroupItem value={item} aria-label={t(`recovery.${item}`)} />
                {t(`recovery.${item}`)}
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
            {submitting ? t('recovery.submitting') : t('recovery.submit')}
          </Button>
          {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
        </div>
      </form>
    </section>
  );
}

function TaskPanel({
  runId,
  task,
  onRunUpdate,
}: {
  runId: string;
  task: AgentTeamTaskAttemptView;
  onRunUpdate: (run: AgentTeamRunView) => void;
}) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const canRetry = task.status === 'failed' && task.retryable;

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError('');
    try {
      const response = await api.retryAgentTeamTask(runId, task.taskKey);
      onRunUpdate(response.run);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : t('tasks.retryFailed'));
    } finally {
      setRetrying(false);
    }
  }

  const completedResult = task.result?.status === 'completed' ? task.result : null;
  const result = JSON.stringify(task.result, null, 2);

  return (
    <article className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <TeamStatusBadge status={task.status} />
        <span className="min-w-0 font-mono text-xs break-all">{task.taskKey}</span>
        <span className="text-[13px] text-muted-foreground">{t(ROLE_LABELS[task.role])}</span>
        {task.developerId ? <span className="font-mono text-xs text-muted-foreground break-all">{task.developerId}</span> : null}
        {task.assignmentTitle ? <span className="min-w-0 text-[13px] break-all">{task.assignmentTitle}</span> : null}
        <span className="text-[13px] text-muted-foreground">{t('tasks.attempt', { count: task.attemptIndex })}</span>
      </div>
      {task.progressText && (task.status === 'running' || task.status === 'waiting_for_input') ? (
        <StreamingMarkdown content={task.progressText} className="mt-2 text-[13px] text-muted-foreground" />
      ) : null}
      {task.error ? <p className="mt-2 text-[13px] text-danger" role="alert">{task.error}</p> : null}
      {completedResult ? (
        <dl className="mt-3 space-y-2 text-[13px]">
          <div>
            <dt className="text-xs text-muted-foreground">{t('tasks.changedFiles')}</dt>
            <dd className="mt-1">
              {completedResult.changedFiles.length > 0 ? (
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {completedResult.changedFiles.map((file) => (
                    <li key={file} className="font-mono text-xs break-all">{file}</li>
                  ))}
                </ul>
              ) : (
                <span className="text-xs text-muted-foreground">{t('tasks.noChangedFiles')}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('tasks.assignedWork')}</dt>
            <dd
              className={cn(
                'mt-1 text-xs',
                completedResult.completedAssignedWork ? 'text-success' : 'text-warning',
              )}
            >
              {completedResult.completedAssignedWork
                ? t('tasks.assignedWorkCompleted')
                : t('tasks.assignedWorkNotCompleted')}
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="mt-3"><ContentDisclosure summary={t('tasks.result')} content={result} /></div>
      {canRetry ? (
        <div className="mt-3">
          <Button type="button" variant="secondary" size="compact" disabled={retrying} onClick={() => void retry()}>
            {retrying ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
            {retrying ? t('tasks.retrying') : t('tasks.retry')}
          </Button>
          {error ? <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p> : null}
        </div>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">{formatDateTime(task.createdAt, locale)}</p>
    </article>
  );
}

function CommandEvidence({ commandId }: { commandId: string }) {
  const { t } = useTranslation('agentTeams');
  const [command, setCommand] = useState<CommandExecutionView | null>(null);
  const [events, setEvents] = useState<CommandExecutionEvent[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let disposed = false;
    let closed = false;
    setError('');
    setCommand(null);
    setEvents([]);
    setReconnecting(false);
    const source = new EventSource(api.commandEventsUrl(commandId), { withCredentials: true });

    const refresh = async () => {
      try {
        const refreshed = await api.command(commandId);
        if (disposed) return;
        setCommand(refreshed);
        if (refreshed.status === 'succeeded' || refreshed.status === 'failed' || refreshed.status === 'cancelled') {
          closed = true;
          source.close();
          setReconnecting(false);
        }
      } catch (failure: unknown) {
        if (!disposed) setError(failure instanceof Error ? failure.message : t('operations.loadFailed'));
      }
    };

    source.onopen = () => {
      if (!disposed) setReconnecting(false);
    };
    source.onerror = () => {
      if (!disposed && !closed) setReconnecting(true);
    };
    source.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseCommandEvent(message.data);
        if (event.commandId !== commandId) return;
        setEvents((current) => appendCommandEvent(current, event));
        if (event.type === 'lifecycle') void refresh();
      } catch {
        // Ignore malformed evidence and keep the persisted Command query authoritative.
      }
    };

    void refresh();
    return () => {
      disposed = true;
      source.close();
    };
  }, [commandId, reloadToken, t]);

  if (error) {
    return <ErrorState title={t('operations.command')} description={error} onAction={() => { setCommand(null); setError(''); setReloadToken((current) => current + 1); }} />;
  }
  if (!command) {
    return <div className="space-y-2" role="status" aria-busy="true"><Skeleton className="h-4 w-40" /><Skeleton className="h-16 w-full" /></div>;
  }

  return (
    <div className="mt-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <TeamStatusBadge status={command.status} />
        {command.exitCode !== null ? <span>{t('operations.exitCode')}: <span className="font-mono tabular-nums">{command.exitCode}</span></span> : null}
        <span className="min-w-0 font-mono break-all">{command.cwd}</span>
      </div>
      <p className="mt-2 font-mono text-xs break-all">{command.command}</p>
      {reconnecting ? (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-warning" role="status">
          <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
          {t('output.reconnecting')}
        </p>
      ) : null}
      <div className="mt-3 max-h-72 overflow-auto rounded-md border border-border bg-surface-subtle p-3" aria-label={t('operations.output')}>
        {events.length === 0 ? <p className="font-sans text-xs text-muted-foreground">{t('output.empty')}</p> : events.map((event) => (
          <div key={event.sequence} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
            <span className="text-right font-mono text-[11px] uppercase text-muted-foreground">{event.type}</span>
            <pre className="min-w-0 font-mono text-xs whitespace-pre-wrap break-words">{event.data}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function OperationPanel({ operation }: { operation: AgentTeamOperationView }) {
  const { t } = useTranslation('agentTeams');
  return (
    <article className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <TeamStatusBadge status={operation.status} />
        <span className="min-w-0 font-mono text-xs break-all">{operation.operationKey}</span>
        <span className="font-mono text-xs text-muted-foreground">{operation.toolName}</span>
      </div>
      <dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('metadata.taskKey')}</dt>
          <dd className="mt-1 font-mono break-all">{operation.taskKey}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('operations.command')}</dt>
          <dd className="mt-1 font-mono break-all">{operation.commandId ?? t('operations.noCommand')}</dd>
        </div>
      </dl>
      {operation.failureReason ? <p className="mt-2 text-[13px] text-danger" role="alert">{operation.failureReason}</p> : null}
      {operation.commandId ? <CommandEvidence commandId={operation.commandId} /> : null}
    </article>
  );
}

export function TeamRunDetailPage({ runId }: { runId: string }) {
  const { t } = useTranslation('agentTeams');
  const { t: tCommon } = useTranslation('common');
  const { locale } = useLocale();
  const runQuery = useAgentTeamRunQuery('personal', runId);
  const [events, setEvents] = useState<AgentTeamRunEvent[]>([]);
  const [streamReconnecting, setStreamReconnecting] = useState(false);
  const [laneFilter, setLaneFilter] = useState('');

  useEffect(() => {
    let disposed = false;
    let closed = false;
    setEvents([]);
    setLaneFilter('');
    setStreamReconnecting(false);
    const source = new EventSource(api.agentTeamRunEventsUrl(runId), { withCredentials: true });

    source.onopen = () => {
      if (!disposed) setStreamReconnecting(false);
    };
    source.onerror = () => {
      if (!disposed && !closed) setStreamReconnecting(true);
    };
    source.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseAgentTeamRunEvent(message.data);
        if (event.runId !== runId) return;
        setEvents((current) => appendDeduplicatedEvent(current, event));
        if (event.type !== 'task.delta') {
          void queryClient.invalidateQueries({ queryKey: agentTeamRunQueryKey(runId) }).catch(() => undefined);
        }
        if (event.type === 'run.status' && isStatusPayload(event.payload) && TERMINAL_RUN_STATUSES.has(event.payload.status as AgentTeamRunView['status'])) {
          closed = true;
          source.close();
          setStreamReconnecting(false);
        }
      } catch {
        // Ignore malformed events; the persisted Run query remains authoritative.
      }
    };

    return () => {
      disposed = true;
      source.close();
    };
  }, [runId]);

  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState('');

  const updateRun = (run: AgentTeamRunView) => {
    queryClient.setQueryData(agentTeamRunQueryKey(runId), run);
  };

  async function pause() {
    if (pauseBusy) return;
    setPauseBusy(true);
    setPauseError('');
    try {
      const response = await api.pauseAgentTeamRun(runId);
      updateRun(response.run);
    } catch (failure: unknown) {
      setPauseError(failure instanceof Error ? failure.message : t('controls.failed'));
    } finally {
      setPauseBusy(false);
    }
  }

  async function resume() {
    if (resumeBusy) return;
    setResumeBusy(true);
    setResumeError('');
    try {
      const response = await api.resumeAgentTeamRun(runId);
      updateRun(response.run);
    } catch (failure: unknown) {
      setResumeError(failure instanceof Error ? failure.message : t('controls.failed'));
    } finally {
      setResumeBusy(false);
    }
  }

  async function cancel() {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError('');
    try {
      const response = await api.cancelAgentTeamRun(runId);
      updateRun(response.run);
      setCancelOpen(false);
    } catch (failure: unknown) {
      setCancelError(failure instanceof Error ? failure.message : t('controls.failed'));
    } finally {
      setCancelBusy(false);
    }
  }

  const memberOutput = useMemo(() => {
    const groups = new Map<string, MemberOutputGroup>();
    for (const event of events) {
      if (event.type !== 'task.delta') continue;
      const payload = taskDeltaOf(event.payload);
      if (!payload || !payload.delta.trim()) continue;
      const existing = groups.get(payload.taskAttemptId);
      if (existing) {
        existing.text += payload.delta;
        existing.lastSequence = event.sequence;
      } else {
        groups.set(payload.taskAttemptId, {
          taskAttemptId: payload.taskAttemptId,
          taskKey: payload.taskKey,
          text: payload.delta,
          lastSequence: event.sequence,
        });
      }
    }
    return [...groups.values()];
  }, [events]);

  if (runQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('run.detail.title') }]} />
        <div className="space-y-4" role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">{t('run.loading')}</span>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-24 w-full" />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
            <Skeleton className="h-96 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        </div>
      </div>
    );
  }

  const notFound = runQuery.isError && runQuery.error instanceof ApiError && runQuery.error.status === 404;
  if (notFound || (!runQuery.isError && !runQuery.data)) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('run.detail.title') }]} />
        <EmptyState title={t('run.unavailable.title')} description={t('run.unavailable.description')} />
      </div>
    );
  }

  if (runQuery.isError || !runQuery.data) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('run.detail.title') }]} />
        <ErrorState title={t('run.detail.title')} description={t('run.loadFailed')} onAction={() => void runQuery.refetch()} />
      </div>
    );
  }

  const run = runQuery.data;
  const canPause = run.status === 'queued' || run.status === 'running' || run.status === 'waiting_for_input';
  const canResume = run.status === 'paused';
  const canCancel = !TERMINAL_RUN_STATUSES.has(run.status);
  const questionInputs = run.pendingInputs.filter((input) => input.status === 'pending' && input.kind === 'question');
  const recoveryInputs = new Map(
    run.pendingInputs
      .filter((input) => input.status === 'pending' && input.kind === 'operation_recovery')
      .map((input) => [input.operationKey ?? '', input]),
  );
  const uncertainOperations = run.operations.filter((operation) => operation.status === 'uncertain');
  const taskById = new Map(run.tasks.map((task) => [task.id, task]));
  const laneOf = (group: MemberOutputGroup) => taskById.get(group.taskAttemptId)?.developerId ?? group.taskKey;
  const lanes = new Map<string, string>();
  for (const group of memberOutput) {
    const lane = laneOf(group);
    if (!lanes.has(lane)) lanes.set(lane, taskById.get(group.taskAttemptId)?.assignmentTitle ?? lane);
  }
  const activeLane = laneFilter && lanes.has(laneFilter) ? laneFilter : '';
  const visibleOutput = activeLane ? memberOutput.filter((group) => laneOf(group) === activeLane) : memberOutput;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }, { label: t('run.detail.title') }]}
        actions={
          <div className="flex flex-wrap items-start justify-end gap-2">
            {canPause ? (
              <div className="flex flex-col items-end gap-1">
                <Button type="button" variant="secondary" size="compact" disabled={pauseBusy || run.desiredControlState === 'pause_requested'} onClick={() => void pause()}>
                  {pauseBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
                  {pauseBusy ? t('controls.pausing') : t('controls.pause')}
                </Button>
                {pauseError ? <p className="text-[13px] text-danger" role="alert">{pauseError}</p> : null}
              </div>
            ) : null}
            {canResume ? (
              <div className="flex flex-col items-end gap-1">
                <Button type="button" variant="secondary" size="compact" disabled={resumeBusy} onClick={() => void resume()}>
                  {resumeBusy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                  {resumeBusy ? t('controls.resuming') : t('controls.resume')}
                </Button>
                {resumeError ? <p className="text-[13px] text-danger" role="alert">{resumeError}</p> : null}
              </div>
            ) : null}
            {canCancel ? (
              <Button type="button" variant="destructive" size="compact" disabled={cancelBusy || run.desiredControlState === 'cancel_requested'} onClick={() => { setCancelError(''); setCancelOpen(true); }}>
                <Ban className="size-4" aria-hidden="true" />
                {cancelBusy ? t('controls.cancelling') : t('controls.cancel')}
              </Button>
            ) : null}
          </div>
        }
      />
      <PageHeading title={t('run.detail.title')} />
      {run.progress ? <RunProgressSection progress={run.progress} /> : null}
      <section className="mt-4 rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-run-metadata">
        <h2 id="agent-team-run-metadata" className="text-sm font-semibold">{t('metadata.title')}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <TeamStatusBadge status={run.status} />
          <CopyableId value={run.id} />
          <span>{t(DESIRED_CONTROL_LABELS[run.desiredControlState])}</span>
        </div>
        <dl className="mt-4 grid gap-4 text-[13px] md:grid-cols-2 xl:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('run.version')}</dt>
            <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <Link
                to="/agent-teams/$teamId"
                params={{ teamId: run.teamId }}
                search={run.originatingConversationId ? { tab: 'conversation' } : { tab: 'configuration' }}
                className="font-medium text-brand-text hover:underline"
              >
                {run.originatingConversationId ? t('openConversation') : t('openTeam')}
              </Link>
              <CopyableId value={run.teamVersion.id} />
              <span className="font-mono tabular-nums">v{run.teamVersion.version}</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('run.mode')}</dt>
            <dd className="mt-1">{t(`run.modeValue.${run.mode}`)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('run.scopeRevision')}</dt>
            <dd className="mt-1 font-mono tabular-nums">{run.scopeRevision}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-muted-foreground">{t('run.intent')}</dt>
            <dd className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{run.intent}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('run.project')}</dt>
            <dd className="mt-1 font-mono break-all">{run.projectDirectory}</dd>
          </div>
          <div className="md:col-span-2 xl:col-span-3">
            <dt className="text-muted-foreground">{t('run.commands')}</dt>
            <dd className="mt-1">
              {run.authorizedCommands.length === 0 ? <span className="text-muted-foreground">{t('run.noCommands')}</span> : (
                <ul className="grid max-h-40 gap-1 overflow-y-auto">
                  {run.authorizedCommands.map((command) => (
                    <li key={command} className="font-mono text-xs break-all">{command}</li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      </section>
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,430px)]">
        <div className="min-w-0 space-y-6">
          {questionInputs.map((input) => {
            const owner = taskById.get(input.taskAttemptId);
            return <PendingInputPanel key={input.id} runId={runId} pendingInput={input} owner={owner} allowCommands={owner?.role !== 'developer'} onRunUpdate={updateRun} />;
          })}
          {uncertainOperations.map((operation) => (
            <OperationRecoveryPanel
              key={operation.key}
              runId={runId}
              operation={operation}
              pendingInput={recoveryInputs.get(operation.operationKey) ?? null}
              onRunUpdate={updateRun}
            />
          ))}
          <section aria-labelledby="agent-team-tasks-title">
            <h2 id="agent-team-tasks-title" className="text-sm font-semibold">{t('tasks.title')}</h2>
            <div className="mt-3 space-y-3">
              {run.tasks.length === 0 ? <EmptyState title={t('tasks.title')} description={t('tasks.empty')} /> : run.tasks.map((task) => (
                <TaskPanel key={task.id} runId={runId} task={task} onRunUpdate={updateRun} />
              ))}
            </div>
          </section>
        </div>
        <div className="min-w-0 space-y-6">
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-output-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="agent-team-output-title" className="text-sm font-semibold">{t('output.title')}</h2>
              <div className="flex flex-wrap items-center gap-2">
                {lanes.size > 1 ? (
                  <Select value={activeLane || '__all__'} onValueChange={(value) => setLaneFilter(value === '__all__' ? '' : value)}>
                    <SelectTrigger aria-label={t('output.lane.label')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">{t('output.lane.all')}</SelectItem>
                      {[...lanes.entries()].map(([lane, label]) => (
                        <SelectItem key={lane} value={lane}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {streamReconnecting ? (
                  <span className="flex items-center gap-1.5 text-[13px] text-warning" role="status">
                    <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                    {t('output.reconnecting')}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="mt-3 max-h-[520px] space-y-2 overflow-y-auto" role="log" aria-live="polite">
              {visibleOutput.length === 0 ? <p className="text-[13px] text-muted-foreground">{t('output.empty')}</p> : visibleOutput.map((group) => {
                const owner = taskById.get(group.taskAttemptId);
                const active = Boolean(owner && ACTIVE_ATTEMPT_STATUSES.has(owner.status));
                return (
                  <MemberOutputGroupView key={`${group.taskAttemptId}:${active ? 'active' : 'settled'}`} group={group} owner={owner} active={active} />
                );
              })}
            </div>
          </section>
          <section aria-labelledby="agent-team-documents-title">
            <h2 id="agent-team-documents-title" className="text-sm font-semibold">{t('documents.title')}</h2>
            <div className="mt-3 space-y-3">
              {run.documents.length === 0 ? <EmptyState title={t('documents.title')} description={t('documents.empty')} /> : run.documents.map((document) => (
                <article key={document.id} className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium">{document.title}</h3>
                    <span>{t('documents.revision', { count: document.revision })}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(document.createdAt, locale)}</span>
                  </div>
                  <dl className="mt-2 grid gap-2 text-[13px]">
                    <div>
                      <dt className="text-muted-foreground">{t('documents.key')}</dt>
                      <dd className="mt-1 font-mono break-all">{document.key}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('documents.upstreamKeys')}</dt>
                      <dd className="mt-1 font-mono break-all">{document.upstreamDocumentKeys.length === 0 ? t('documents.noUpstreamKeys') : document.upstreamDocumentKeys.join(', ')}</dd>
                    </div>
                  </dl>
                  <div className="mt-3"><ContentDisclosure summary={t('documents.content')} content={document.content} markdown /></div>
                </article>
              ))}
            </div>
          </section>
          <section aria-labelledby="agent-team-operations-title">
            <h2 id="agent-team-operations-title" className="text-sm font-semibold">{t('operations.title')}</h2>
            <div className="mt-3 space-y-3">
              {run.operations.length === 0 ? <EmptyState title={t('operations.title')} description={t('operations.empty')} /> : run.operations.map((operation) => (
                <OperationPanel key={operation.key} operation={operation} />
              ))}
            </div>
          </section>
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-outcome-title">
            <h2 id="agent-team-outcome-title" className="text-sm font-semibold">{t('outcome.title')}</h2>
            {run.outcome ? (
              <div className="mt-3 space-y-4 text-[13px]">
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground">{t('outcome.summary')}</h3>
                  <StreamingMarkdown content={run.outcome.summary} className="mt-1 text-[13px]" />
                </div>
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground">{t('outcome.unresolved')}</h3>
                  {run.outcome.unresolvedIssues.length === 0 ? <p className="mt-1 text-muted-foreground">{t('outcome.noUnresolved')}</p> : (
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {run.outcome.unresolvedIssues.map((issue) => <li key={issue} className="whitespace-pre-wrap break-words">{issue}</li>)}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="text-xs font-medium text-muted-foreground">{t('outcome.criteria')}</h3>
                  <ul className="mt-2 space-y-3">
                    {run.outcome.criterionAssessments.map((assessment) => (
                      <li key={`${assessment.criterion}-${assessment.assessment}`}>
                        <div className="flex flex-wrap items-center gap-2"><AssessmentBadge assessment={assessment.assessment} /><span className="whitespace-pre-wrap break-words">{assessment.criterion}</span></div>
                        <h4 className="mt-2 text-xs font-medium text-muted-foreground">{t('outcome.evidence')}</h4>
                        {assessment.evidence.length > 0 ? (
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                            {assessment.evidence.map((item) => <li key={item} className="whitespace-pre-wrap break-words">{item}</li>)}
                          </ul>
                        ) : <p className="mt-1 text-muted-foreground">{t('outcome.noEvidence')}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : <p className="mt-2 text-[13px] text-muted-foreground">{t('outcome.empty')}</p>}
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!cancelBusy) setCancelOpen(open);
        }}
        title={t('controls.cancelTitle')}
        description={t('controls.cancelDescription')}
        confirmLabel={t('controls.cancelConfirm')}
        cancelLabel={tCommon('actions.cancel')}
        busyLabel={t('controls.cancelling')}
        error={cancelError}
        busy={cancelBusy}
        onConfirm={() => void cancel()}
      />
    </div>
  );
}
