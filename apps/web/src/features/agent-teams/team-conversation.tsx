import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowDown,
  Ban,
  Download,
  FileText,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type {
  AgentTeamConversationMessage,
  AgentTeamConversationPendingInputView,
  AgentTeamMode,
  AgentTeamRunStatus,
  AgentTeamTaskAttemptStatus,
} from '@worklite/contracts';
import { ApiError, api, parseAgentTeamConversationEvent } from '@/api/client';
import { agentTeamConversationQueryKey, useAgentTeamConversationQuery, useAgentTeamDocumentQuery } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { StatusBadge, toStatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';

function commandDraftLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sameCommands(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((command, index) => command === right[index]);
}
const TERMINAL_RUN_STATUSES = new Set<AgentTeamRunStatus>(['succeeded', 'failed', 'cancelled']);
const ROLE_LABELS = {
  planner: 'role.planner',
  test_designer: 'role.test_designer',
  developer: 'role.developer',
  test_author: 'role.test_author',
  test_runner: 'role.test_runner',
  reviewer: 'role.reviewer',
} as const;

const MODE_LABELS = {
  plan_only: 'conversation.mode.plan_only',
  validate_existing: 'conversation.mode.validate_existing',
  implement_and_validate: 'conversation.mode.implement_and_validate',
} as const;

function isAgentTeamMode(value: string): value is AgentTeamMode {
  return value === 'plan_only' || value === 'validate_existing' || value === 'implement_and_validate';
}

type ConversationUiStatus = AgentTeamRunStatus | AgentTeamTaskAttemptStatus;
type RecoveryDecision = 'adopt_command' | 'mark_failed' | 'replay';

// Team statuses keep their own wording but share the product-wide status presentation.
function ConversationStatusBadge({ status }: { status: ConversationUiStatus }) {
  const { t } = useTranslation('agentTeams');
  return <StatusBadge key={status} status={toStatusKey(status)} label={t(`run.status.${status}`)} />;
}

function runStateText(
  message: Extract<AgentTeamConversationMessage, { kind: 'run_state' }>,
  t: TFunction<'agentTeams'>,
): string {
  return [
    message.role ? t(ROLE_LABELS[message.role]) : null,
    message.assignmentTitle ?? message.developerId,
    message.taskStatus ? t(`run.status.${message.taskStatus}`) : t(`run.status.${message.status}`),
    message.outcomeSummary,
  ].filter(Boolean).join(' · ');
}

async function selectOption(value: string, onSend: (value: string) => Promise<void>) {
  await onSend(value);
}

function MessageItem({
  message,
  selectedDocumentId,
  onSend,
  onOpenDocument,
}: {
  message: AgentTeamConversationMessage;
  selectedDocumentId: string | null;
  onSend: (value: string) => Promise<void>;
  onOpenDocument: (documentId: string) => void;
}) {
  const { t } = useTranslation('agentTeams');
  const isUser = message.speaker === 'user';
  const speaker = message.speaker === 'user'
    ? t('conversation.speaker.user')
      : message.speaker === 'coordinator'
        ? t('conversation.speaker.coordinator')
        : message.speaker === 'member' && message.kind === 'file_delivery'
          ? message.document.role
            ? t(`role.${message.document.role}`)
            : t('conversation.speaker.member')
        : message.kind === 'member_question'
          ? `${t(ROLE_LABELS[message.role])}${message.assignmentTitle ? ` · ${message.assignmentTitle}` : ''}`
          : t('conversation.speaker.system');

  let body: ReactNode;
  switch (message.kind) {
    case 'task_request':
    case 'answer':
    case 'note':
    case 'run_answer':
      body = <p className="min-w-0 whitespace-pre-wrap break-words">{message.text}</p>;
      if (message.kind === 'run_answer' && message.authorizedCommands.length > 0) {
        body = (
          <div className="min-w-0 space-y-2">
            {body}
            <ul className="space-y-1">
              {message.authorizedCommands.map((command) => (
                <li key={command} className="font-mono text-xs break-all">{command}</li>
              ))}
            </ul>
          </div>
        );
      }
      break;
    case 'coordinator_question':
      body = (
        <div className="min-w-0 space-y-3">
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
          {message.options.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label={message.text}>
              {message.options.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant="secondary"
                  size="compact"
                  className="max-w-full justify-start"
                  onClick={() => void selectOption(option.value, onSend)}
                >
                  <span className="min-w-0 truncate">{message.field === 'mode' && isAgentTeamMode(option.value) ? t(MODE_LABELS[option.value]) : option.label}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      );
      break;
    case 'member_question':
      body = <p className="min-w-0 whitespace-pre-wrap break-words">{message.text}</p>;
      break;
    case 'status':
      body = <p className="min-w-0 whitespace-pre-wrap break-words">{message.text}</p>;
      break;
    case 'file_delivery':
      body = (
        <Button
          type="button"
          variant="link"
          size="compact"
          className="max-w-full justify-start px-0 text-left"
          aria-current={selectedDocumentId === message.document.id}
          onClick={() => onOpenDocument(message.document.id)}
        >
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-all">{message.document.fileName}</span>
        </Button>
      );
      break;
    case 'delivery_failed':
      body = (
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-xs break-all">{message.document.fileName}</p>
          <p className="text-danger">{message.error || t('conversation.fileDeliveryFailed')}</p>
        </div>
      );
      break;
    case 'run_state':
      body = <p className="min-w-0 whitespace-pre-wrap break-words">{runStateText(message, t)}</p>;
      break;
  }

  return (
    <article className={cn('flex w-full gap-3', isUser && 'justify-end')} aria-label={speaker}>
      {!isUser ? (
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-subtle text-[10px] font-semibold uppercase text-muted-foreground">
          {speaker.slice(0, 2)}
        </div>
      ) : null}
      <div className={cn('min-w-0 max-w-[min(46rem,88%)] rounded-lg border p-3 text-[13px]', isUser ? 'border-border bg-surface-subtle' : 'border-border bg-surface')}>
        <p className="text-xs font-medium text-muted-foreground">{speaker}</p>
        <div className="mt-1">{body}</div>
      </div>
    </article>
  );
}

function DocumentViewer({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const { t } = useTranslation('agentTeams');
  const documentQuery = useAgentTeamDocumentQuery('personal', documentId);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  async function download() {
    if (downloading || !documentQuery.data) return;
    setDownloading(true);
    setDownloadError('');
    try {
      const blob = await api.downloadAgentTeamDocument(documentId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = documentQuery.data.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      setDownloadError(error instanceof Error ? error.message : t('conversation.document.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section
      className={cn(
        'min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs',
        'fixed inset-4 z-40 overflow-hidden flex flex-col md:static md:inset-auto md:z-auto',
      )}
      aria-labelledby="agent-team-document-title"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="agent-team-document-title" className="text-sm font-semibold">{documentQuery.data?.title ?? t('conversation.document.loading')}</h2>
          {documentQuery.data ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('conversation.document.revision', { count: documentQuery.data.revision })}</p>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="icon-compact" aria-label={t('conversation.document.close')} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="compact" disabled={downloading || !documentQuery.data} onClick={() => void download()}>
          {downloading ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
          {downloading ? t('conversation.document.downloading') : t('conversation.document.download')}
        </Button>
        {downloadError ? <p className="w-full text-[13px] text-danger" role="alert">{downloadError}</p> : null}
        {documentQuery.data?.deliveryStatus === 'failed' ? (
          <p className="w-full text-[13px] text-danger" role="alert">
            {documentQuery.data.deliveryError || t('conversation.fileDeliveryFailed')}
          </p>
        ) : null}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-surface-subtle p-3">
        {documentQuery.isLoading ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : documentQuery.isError ? (
          <ErrorState
            title={t('conversation.document.title')}
            description={t('conversation.document.loadFailed')}
            onAction={() => void documentQuery.refetch()}
          />
        ) : (
          <pre className="min-w-0 font-mono text-xs whitespace-pre-wrap break-words">{documentQuery.data?.content}</pre>
        )}
      </div>
    </section>
  );
}

function PendingQuestionPanel({
  input,
  attribution,
  teamId,
}: {
  input: AgentTeamConversationPendingInputView;
  attribution: string | null;
  teamId: string;
}) {
  const { t } = useTranslation('agentTeams');
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !answer.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await api.answerAgentTeamRun(input.runId, {
        pendingInputId: input.pendingInputId,
        scopeRevision: input.scopeRevision,
        answer: answer.trim(),
        authorizedCommands: [],
      });
      await queryClient.invalidateQueries({ queryKey: agentTeamConversationQueryKey(teamId) });
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : t('input.answerFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby={`agent-team-extra-question-${input.pendingInputId}`}>
      <h2 id={`agent-team-extra-question-${input.pendingInputId}`} className="text-sm font-semibold">{t('input.title')}</h2>
      {attribution ? <p className="mt-1 text-xs text-muted-foreground">{attribution}</p> : null}
      <p className="mt-2 text-[13px] whitespace-pre-wrap break-words">{input.question}</p>
      <form className="mt-3 space-y-3" onSubmit={submit}>
        <Field label={t('input.answer')} htmlFor={`agent-team-extra-answer-${input.pendingInputId}`}>
          <Textarea
            id={`agent-team-extra-answer-${input.pendingInputId}`}
            value={answer}
            placeholder={t('input.answerPlaceholder')}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <Button type="submit" disabled={submitting || answer.trim().length === 0}>
            {submitting ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
            {submitting ? t('input.answering') : t('input.answer')}
          </Button>
          {error ? <p className="text-[13px] text-danger" role="alert">{error}</p> : null}
        </div>
      </form>
    </section>
  );
}

export function TeamConversation({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const { t: tCommon } = useTranslation('common');
  const conversationQuery = useAgentTeamConversationQuery('personal', teamId);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [streamReconnecting, setStreamReconnecting] = useState(false);
  const [coordinatorMentionRemoved, setCoordinatorMentionRemoved] = useState(false);
  const [text, setText] = useState('');
  const [authorizedCommands, setAuthorizedCommands] = useState('');
  const [pendingSubmission, setPendingSubmission] = useState<{
    id: string;
    text: string;
    mentions: boolean;
    commands: string[];
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [recoveryDecision, setRecoveryDecision] = useState<RecoveryDecision>('adopt_command');
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [runAction, setRunAction] = useState<'pause' | 'resume' | 'cancel' | 'retry' | null>(null);
  const [runActionError, setRunActionError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    const conversationId = conversationQuery.data?.id;
    if (!conversationId) return;
    let disposed = false;
    const source = new EventSource(api.agentTeamConversationEventsUrl(teamId), { withCredentials: true });
    source.onopen = () => {
      if (!disposed) setStreamReconnecting(false);
    };
    source.onerror = () => {
      if (!disposed) setStreamReconnecting(true);
    };
    source.onmessage = (message) => {
      if (disposed) return;
      try {
        const event = parseAgentTeamConversationEvent(message.data);
        if (event.conversationId !== conversationId) return;
        void queryClient.invalidateQueries({ queryKey: agentTeamConversationQueryKey(teamId) }).catch(() => undefined);
      } catch {
        // The persisted conversation query remains authoritative.
      }
    };
    return () => {
      disposed = true;
      source.close();
    };
  }, [conversationQuery.data?.id, teamId]);

  const conversation = conversationQuery.data;
  const messages = conversation?.messages ?? [];
  const messageCount = messages.length;
  const activeIntake = conversation
    ? conversation.intakes.find((intake) => intake.id === conversation.activeIntakeId) ?? null
    : null;
  const pendingQuestion = activeIntake?.unresolvedField
    ? messages.filter((message): message is Extract<AgentTeamConversationMessage, { kind: 'coordinator_question' }> => message.kind === 'coordinator_question' && message.intakeId === activeIntake.id).at(-1) ?? null
    : null;
  const pendingInput = conversation?.pendingInput ?? null;
  const activeRun = conversation?.activeRun ?? null;
  const pendingQuestions = (conversation?.pendingInputs ?? []).filter((input) => input.kind === 'question');
  const extraPendingQuestions = pendingQuestions.filter((input) => input.pendingInputId !== pendingInput?.pendingInputId);
  const questionAttribution = (input: AgentTeamConversationPendingInputView) => {
    const message = messages.find((candidate) => candidate.kind === 'member_question' && candidate.pendingInputId === input.pendingInputId);
    return message && message.kind === 'member_question'
      ? `${t(ROLE_LABELS[message.role])}${message.assignmentTitle ? ` · ${message.assignmentTitle}` : ''}`
      : null;
  };
  const commandGrantQuestion = pendingInput?.kind === 'question' && messages.some((message) => message.kind === 'member_question' && message.pendingInputId === pendingInput.pendingInputId && message.role !== 'developer');
  const answerMode = Boolean(pendingQuestion || pendingInput?.kind === 'question');
  const coordinatorMention = !answerMode && !coordinatorMentionRemoved;
  useEffect(() => {
    if (!following || !transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [following, messageCount]);

  useEffect(() => {
    if (
      !pendingSubmission
      || pendingSubmission.text === text.trim()
      && pendingSubmission.mentions === coordinatorMention
      && sameCommands(pendingSubmission.commands, commandDraftLines(authorizedCommands))
    ) return;
    setPendingSubmission(null);
  }, [authorizedCommands, coordinatorMention, pendingSubmission, text]);

  if (conversationQuery.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-live="polite">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }

  if (conversationQuery.isError || !conversation) {
    return (
      <ErrorState
        title={t('conversation.tab')}
        description={t('conversation.loadFailed')}
        onAction={() => void conversationQuery.refetch()}
      />
    );
  }

  const queuedRequest = activeIntake?.status === 'queued'
    ? messages.find((message): message is Extract<AgentTeamConversationMessage, { kind: 'task_request' }> => message.kind === 'task_request' && message.intakeId === activeIntake.id) ?? null
    : null;
  const canPause = activeRun !== null && ['queued', 'running', 'waiting_for_input'].includes(activeRun.status);
  const canResume = activeRun?.status === 'paused';
  const canCancel = activeRun !== null && !TERMINAL_RUN_STATUSES.has(activeRun.status);
  const retryableTaskKeys = activeRun
    ? (activeRun.retryableTaskKeys.length > 0 ? activeRun.retryableTaskKeys : activeRun.retryableTaskKey ? [activeRun.retryableTaskKey] : [])
    : [];
  const canRetry = retryableTaskKeys.length > 0;
  const retryAttribution = (taskKey: string) => {
    const message = [...messages].reverse().find((candidate) => candidate.kind === 'run_state' && candidate.taskKey === taskKey && (candidate.assignmentTitle || candidate.developerId));
    return message && message.kind === 'run_state' ? message.assignmentTitle ?? message.developerId : null;
  };
  const hasContextualInspector = activeIntake?.status === 'queued'
    || activeRun !== null
    || pendingInput?.kind === 'operation_recovery'
    || extraPendingQuestions.length > 0
    || selectedDocumentId !== null;
  const placeholder = pendingQuestion?.field === 'projectDirectory'
    ? t('conversation.enterDirectory')
    : pendingQuestion?.field === 'mode'
      ? t('conversation.question.mode')
      : pendingInput?.kind === 'question'
        ? t('conversation.answerPlaceholder')
        : t('conversation.inputPlaceholder');

  async function sendConversation(input: {
    text: string;
    mentions: boolean;
    authorizedCommands?: string[];
  }): Promise<void> {
    const trimmed = input.text.trim();
    if (!trimmed || sending) return;
    const commands = input.authorizedCommands ?? [];
    const stableSubmission = pendingSubmission?.text === trimmed
      && pendingSubmission.mentions === input.mentions
      && sameCommands(pendingSubmission.commands, commands)
      ? pendingSubmission
      : null;
    const submissionId = stableSubmission?.id ?? crypto.randomUUID();
    setSending(true);
    setSendError('');
    try {
      const response = await api.sendAgentTeamConversationMessage(teamId, {
        submissionId,
        text: trimmed,
        mentions: input.mentions ? ['coordinator'] : [],
        ...(commands.length > 0 ? { authorizedCommands: commands } : {}),
      });
      queryClient.setQueryData(agentTeamConversationQueryKey(teamId), response.conversation);
      setPendingSubmission(null);
      setText('');
      setAuthorizedCommands('');
      setCoordinatorMentionRemoved(false);
    } catch (error: unknown) {
      setPendingSubmission({ id: submissionId, text: trimmed, mentions: input.mentions, commands });
      const invalidDirectory = error instanceof ApiError
        && error.status === 400
        && pendingQuestion?.field === 'projectDirectory';
      setSendError(invalidDirectory ? t('conversation.invalidDirectory') : error instanceof Error ? error.message : t('conversation.sendFailed'));
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const commands = commandGrantQuestion ? commandDraftLines(authorizedCommands) : [];
    void sendConversation({ text, mentions: coordinatorMention, authorizedCommands: commands });
  }

  async function updateRun(action: 'pause' | 'resume' | 'cancel' | 'retry', taskKey?: string) {
    if (!activeRun || runAction) return;
    setRunAction(action);
    setRunActionError('');
    try {
      if (action === 'pause') await api.pauseAgentTeamRun(activeRun.runId);
      else if (action === 'resume') await api.resumeAgentTeamRun(activeRun.runId);
      else if (action === 'cancel') {
        await api.cancelAgentTeamRun(activeRun.runId);
        setCancelOpen(false);
      } else {
        const target = taskKey ?? activeRun.retryableTaskKey;
        if (target) await api.retryAgentTeamTask(activeRun.runId, target);
      }
      await queryClient.invalidateQueries({ queryKey: agentTeamConversationQueryKey(teamId) });
    } catch (error: unknown) {
      setRunActionError(error instanceof Error ? error.message : t('controls.failed'));
    } finally {
      setRunAction(null);
    }
  }

  async function recoverOperation() {
    if (!pendingInput || pendingInput.kind !== 'operation_recovery' || !pendingInput.operationKey || recovering) return;
    setRecovering(true);
    setRecoveryError('');
    try {
      await api.recoverAgentTeamOperation(pendingInput.runId, pendingInput.operationKey, {
        operationKey: pendingInput.operationKey,
        decision: recoveryDecision,
      });
      await queryClient.invalidateQueries({ queryKey: agentTeamConversationQueryKey(teamId) });
    } catch (error: unknown) {
      setRecoveryError(error instanceof Error ? error.message : t('recovery.failed'));
    } finally {
      setRecovering(false);
    }
  }

  function onTranscriptScroll() {
    const element = transcriptRef.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 32);
  }

  return (
    <div className={cn('grid min-w-0 gap-4', hasContextualInspector && 'lg:grid-cols-[minmax(0,1fr)_360px]')}>
      <section className="flex min-h-[560px] min-w-0 flex-col rounded-lg border border-border bg-surface" aria-labelledby="agent-team-conversation-title">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 id="agent-team-conversation-title" className="text-sm font-semibold">{t('conversation.tab')}</h2>
            {conversation.latestProjectDirectory ? (
              <p className="mt-1 max-w-full font-mono text-xs break-all text-muted-foreground">{conversation.latestProjectDirectory}</p>
            ) : null}
          </div>
          {streamReconnecting ? (
            <span className="flex items-center gap-1.5 text-[13px] text-warning" role="status">
              <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              {t('conversation.reconnecting')}
            </span>
          ) : null}
        </div>
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="h-[min(56vh,520px)] min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
          role="log"
          aria-live="polite"
          aria-label={t('conversation.tab')}
        >
          {messages.length === 0 ? <EmptyState title={t('conversation.title')} description={t('conversation.empty')} /> : messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              selectedDocumentId={selectedDocumentId}
              onSend={(value) => sendConversation({ text: value, mentions: false })}
              onOpenDocument={setSelectedDocumentId}
            />
          ))}
        </div>
        {!following ? (
          <div className="relative">
            <Button
              type="button"
              variant="secondary"
              size="compact"
              className="absolute bottom-3 right-4"
              onClick={() => {
                setFollowing(true);
                const element = transcriptRef.current;
                if (element) element.scrollTop = element.scrollHeight;
              }}
            >
              <ArrowDown className="size-4" aria-hidden="true" />
              {t('conversation.returnToEnd')}
            </Button>
          </div>
        ) : null}
        {/* Escape is a transient composer shortcut while the form remains submitted by its button. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <form
          className="border-t border-border p-4"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && coordinatorMention) {
              event.preventDefault();
              setCoordinatorMentionRemoved(true);
              setPendingSubmission(null);
            }
          }}
        >
          <div className="rounded-lg border border-input bg-surface p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <div className="flex min-w-0 flex-wrap items-start gap-2">
              {!answerMode ? (
                <Button
                  type="button"
                  variant={coordinatorMention ? 'secondary' : 'ghost'}
                  size="compact"
                  className="shrink-0"
                  aria-label={coordinatorMention ? t('conversation.removeMention') : t('conversation.mention')}
                  aria-pressed={coordinatorMention}
                  onClick={() => {
                    setCoordinatorMentionRemoved((current) => !current);
                    setPendingSubmission(null);
                  }}
                >
                  {t('conversation.mention')}
                  {coordinatorMention ? <X className="size-3.5" aria-hidden="true" /> : null}
                </Button>
              ) : null}
              <Textarea
                className="min-h-20 min-w-0 flex-1 resize-y border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                value={text}
                placeholder={placeholder}
                aria-label={answerMode ? t('conversation.answerPlaceholder') : t('conversation.inputPlaceholder')}
                onChange={(event) => {
                  setText(event.target.value);
                  if (pendingSubmission?.text !== event.target.value) setPendingSubmission(null);
                }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2">
              {sendError ? <p className="text-[13px] text-danger" role="alert">{sendError}</p> : <span />}
              <Button type="submit" disabled={sending || text.trim().length === 0}>
                {sending ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                {sending ? t('conversation.sending') : t('conversation.send')}
              </Button>
            </div>
          </div>
          {commandGrantQuestion ? (
            <div className="mt-3">
              <Field label={t('input.commands')} htmlFor="agent-team-conversation-commands">
                <Textarea
                  id="agent-team-conversation-commands"
                  className="min-h-20"
                  value={authorizedCommands}
                  placeholder={t('run.commandsPlaceholder')}
                  onChange={(event) => setAuthorizedCommands(event.target.value)}
                />
              </Field>
            </div>
          ) : null}
        </form>
      </section>
      {hasContextualInspector ? <aside className="min-w-0 space-y-4">
        {activeIntake?.status === 'queued' ? (
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-queued-intake">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="agent-team-queued-intake" className="text-sm font-semibold">{t('conversation.queuedTask')}</h2>
              <ConversationStatusBadge status="queued" />
            </div>
            <p className="mt-3 whitespace-pre-wrap break-words text-[13px]">{activeIntake.goal ?? queuedRequest?.text}</p>
            <p className="mt-2 text-[13px] text-muted-foreground">{t('conversation.queuedWaiting')}</p>
          </section>
        ) : null}
        {activeRun ? (
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-run-state">
            <h2 id="agent-team-run-state" className="text-sm font-semibold">{t('conversation.run')}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ConversationStatusBadge status={activeRun.status} />
              <Link
                to="/agent-team-runs/$runId"
                params={{ runId: activeRun.runId }}
                className="text-[13px] font-medium text-brand-text hover:underline"
              >
                {t('conversation.openRun')}
              </Link>
            </div>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div>
                <dt className="text-muted-foreground">{t('conversation.project')}</dt>
                <dd className="mt-1 font-mono break-all">{activeRun.projectDirectory}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('run.mode')}</dt>
                <dd>{t(`conversation.mode.${activeRun.mode}`)}</dd>
              </div>
            </dl>
            {activeRun.progress ? (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
                <span>{t(`progress.phaseValue.${activeRun.progress.phase}`)}</span>
                {activeRun.progress.totalAssignments > 0 ? (
                  <span className="tabular-nums">{t('progress.assignments', { completed: activeRun.progress.completedAssignments, total: activeRun.progress.totalAssignments })}</span>
                ) : null}
                {activeRun.progress.activeDeveloperIds.length > 0 ? (
                  <span className="min-w-0 font-mono text-xs break-all">{activeRun.progress.activeDeveloperIds.join(', ')}</span>
                ) : null}
                <span>{t('progress.nextStep')}: {t(`progress.nextStepValue.${activeRun.progress.nextStep}`)}</span>
              </div>
            ) : null}
            {pendingQuestions.length > 0 ? (
              <p className="mt-2 text-[13px] text-warning" role="status">{t('progress.pendingQuestions', { count: pendingQuestions.length })}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {canPause ? (
                <Button type="button" variant="secondary" size="compact" disabled={runAction !== null} onClick={() => void updateRun('pause')}>
                  {runAction === 'pause' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
                  {runAction === 'pause' ? t('controls.pausing') : t('controls.pause')}
                </Button>
              ) : null}
              {canResume ? (
                <Button type="button" variant="secondary" size="compact" disabled={runAction !== null} onClick={() => void updateRun('resume')}>
                  {runAction === 'resume' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                  {runAction === 'resume' ? t('controls.resuming') : t('controls.resume')}
                </Button>
              ) : null}
              {canCancel ? (
                <Button type="button" variant="destructive" size="compact" disabled={runAction !== null} onClick={() => setCancelOpen(true)}>
                  <Ban className="size-4" aria-hidden="true" />
                  {runAction === 'cancel' ? t('controls.cancelling') : t('controls.cancel')}
                </Button>
              ) : null}
              {canRetry && retryableTaskKeys.length === 1 ? (
                <Button type="button" size="compact" disabled={runAction !== null} onClick={() => void updateRun('retry', retryableTaskKeys[0])}>
                  {runAction === 'retry' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                  {runAction === 'retry' ? t('tasks.retrying') : t('tasks.retry')}
                </Button>
              ) : null}
            </div>
            {canRetry && retryableTaskKeys.length > 1 ? (
              <ul className="mt-3 space-y-2">
                {retryableTaskKeys.map((taskKey) => (
                  <li key={taskKey} className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="secondary" size="compact" disabled={runAction !== null} onClick={() => void updateRun('retry', taskKey)}>
                      {runAction === 'retry' ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
                      {runAction === 'retry' ? t('tasks.retrying') : t('tasks.retryTask', { taskKey })}
                    </Button>
                    {retryAttribution(taskKey) ? <span className="min-w-0 text-[13px] text-muted-foreground break-all">{retryAttribution(taskKey)}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {runActionError ? <p className="mt-2 text-[13px] text-danger" role="alert">{runActionError}</p> : null}
          </section>
        ) : null}
        {extraPendingQuestions.map((input) => (
          <PendingQuestionPanel key={input.pendingInputId} input={input} attribution={questionAttribution(input)} teamId={teamId} />
        ))}
        {pendingInput?.kind === 'operation_recovery' ? (
          <section className="rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-conversation-recovery">
            <h2 id="agent-team-conversation-recovery" className="text-sm font-semibold">{t('recovery.title')}</h2>
            <p className="mt-2 text-[13px] whitespace-pre-wrap break-words">{pendingInput.question}</p>
            <div className="mt-3">
              <Field label={t('recovery.decision')} htmlFor="agent-team-conversation-recovery-decision">
                <Select value={recoveryDecision} onValueChange={(value) => setRecoveryDecision(value as RecoveryDecision)}>
                  <SelectTrigger id="agent-team-conversation-recovery-decision">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['adopt_command', 'mark_failed', 'replay'] as const).map((decision) => (
                      <SelectItem key={decision} value={decision}>{t(`recovery.${decision}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="mt-3">
              <Button type="button" disabled={recovering} onClick={() => void recoverOperation()}>
                {recovering ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                {recovering ? t('recovery.submitting') : t('recovery.submit')}
              </Button>
              {recoveryError ? <p className="mt-2 text-[13px] text-danger" role="alert">{recoveryError}</p> : null}
            </div>
          </section>
        ) : null}
        {selectedDocumentId ? <DocumentViewer documentId={selectedDocumentId} onClose={() => setSelectedDocumentId(null)} /> : null}
      </aside> : null}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (runAction !== 'cancel') setCancelOpen(open);
        }}
        title={t('controls.cancelTitle')}
        description={t('controls.cancelDescription')}
        confirmLabel={t('controls.cancelConfirm')}
        cancelLabel={tCommon('actions.cancel')}
        busyLabel={t('controls.cancelling')}
        error={runActionError}
        busy={runAction === 'cancel'}
        onConfirm={() => void updateRun('cancel')}
      />
    </div>
  );
}
