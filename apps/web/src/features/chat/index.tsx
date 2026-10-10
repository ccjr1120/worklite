import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronRight, List, Plus, ScrollText, Settings, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, DispatchChatRequest, RunView, WorkflowView } from '@worklite/contracts';
import { ApiError, api, parseAgentExecutionEvent } from '@/api/client';
import { chatConversationsQueryKey, useAgentQuery, useChatConversationQuery, useMcpServersQuery, useModelProvidersQuery, useSkillsQuery, useWorkflowsQuery } from '@/api/queries';
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { StatusBadge, type StatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { focusRingInset } from '@/components/ui/interaction';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';
import { Composer, SLASH_COMMANDS, type SlashCommand } from './composer';
import { Configuration } from './configuration';
import { downloadExecutionLog } from './execution-log';
import { ConversationList } from './conversation-list';
import { ConversationRecords } from './records';
import { ChannelConfiguration } from './channel-configuration';
import { TaskCard } from './task-messages';
import { PinnedExecutionBar, PinTrackingContext, usePinTracking, type PinCandidate } from './pinned-executions';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CHAT_AGENT_ID } from '@worklite/contracts';
import { AssistantTurn, buildTimeline, CancelledNote, FailureNote, QuestionNote, QueueRows, TranscriptSkeleton, UserMessage, WorkflowRunRow } from './transcript';

const INCOMPLETE_SKILL_REQUEST = 'The model returned an incomplete Skill request. Its JSON ended before the request was complete.';
const INVALID_SKILL_REQUEST = 'The model returned an invalid Skill request. Its arguments could not be parsed or did not match the required structure.';
const GENERIC_AGENT_ERROR = 'Chat could not complete this turn. Check its provider configuration and try again.';
const AGENT_TURN_ERROR = 'Chat could not complete this turn.';
const SKILL_EXECUTION_ERROR = 'The Skill script could not be completed.';
const RESTARTED_AGENT_ERROR = 'The API restarted before this Chat turn completed.';

type QueuedMessage = { id: string; text: string };
type ActiveWorkflowRun = { workflow: WorkflowView; run: RunView; input: string };
const conversationDrafts = new Map<string, { draft: string; queued: QueuedMessage[]; paused: boolean }>();

function readSelectedConversation() {
  try { return window.localStorage.getItem('worklite.chat.selected'); } catch { return null; }
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

function mergeExecutionSnapshot(current: AgentExecutionView | null, next: AgentExecutionView | null) {
  if (!current || !next || current.id !== next.id) return next;
  if (next.updatedAt < current.updatedAt) return current;
  const ids = new Set(next.messages.map((entry) => entry.id));
  return { ...next, messages: [...next.messages, ...current.messages.filter((entry) => entry.role === 'assistant' && !ids.has(entry.id))] };
}

function ChatWorkspace() {
  const workspaceSlug = 'personal';
  const { t } = useTranslation(['assistant', 'common']);
  const locationSearch = useRouterState({ select: (state) => state.location.search as Record<string, unknown> });
  const navigate = useNavigate();
  const agentQuery = useAgentQuery(workspaceSlug, CHAT_AGENT_ID);
  const providersQuery = useModelProvidersQuery(workspaceSlug);
  const mcpServersQuery = useMcpServersQuery(workspaceSlug);
  const workflowsQuery = useWorkflowsQuery(workspaceSlug);
  const { applyAppearancePreference } = useTheme();
  const { locale } = useLocale();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => typeof locationSearch.conversation === 'string' ? locationSearch.conversation : readSelectedConversation());
  const conversationQuery = useChatConversationQuery(selectedConversationId);
  const skillsQuery = useSkillsQuery(workspaceSlug);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const pendingDispatch = useRef<{ signature: string; id: string } | null>(null);
  const dispatchRequest = useCallback(async (input: Omit<DispatchChatRequest, 'submissionId'>) => {
    const signature = JSON.stringify(input);
    if (pendingDispatch.current?.signature !== signature) pendingDispatch.current = { signature, id: `web_${crypto.randomUUID()}` };
    return api.dispatchChat({ ...input, submissionId: pendingDispatch.current.id });
  }, []);
  const sendConversation = useCallback(async (message: string, executionId: string | null, questionId?: string, submissionId?: string, authorization?: Pick<DispatchChatRequest, 'recoveryDecision' | 'newConversation'>) => {
    const input = { message, target: { kind: 'conversation' as const }, executionId, ...(questionId ? { questionId } : {}), ...authorization };
    const result = submissionId ? await api.dispatchChat({ ...input, submissionId }) : await dispatchRequest(input);
    if (result.reference.kind !== 'conversation') throw new Error('The conversation did not return an execution.');
    const execution = await api.agentExecution(workspaceSlug, CHAT_AGENT_ID, result.reference.executionId);
    pendingDispatch.current = null;
    void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
    void queryClient.invalidateQueries({ queryKey: ['chat-conversation'] });
    return execution;
  }, [dispatchRequest, workspaceSlug]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [execution, setExecution] = useState<AgentExecutionView | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowView | null>(null);
  const [workflowRun, setWorkflowRun] = useState<ActiveWorkflowRun | null>(null);
  const [draft, setDraft] = useState(() => conversationDrafts.get(selectedConversationId ?? 'new')?.draft ?? '');
  const [settingsOpen, setSettingsOpen] = useState(locationSearch.view === 'channels' || locationSearch.view === 'configuration');
  const [settingsSection, setSettingsSection] = useState<'channels' | 'configuration'>(locationSearch.view === 'channels' || locationSearch.view === 'configuration' ? locationSearch.view : 'channels');
  const [configSelection, setConfigSelection] = useState('');
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [configSaving, setConfigSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [extensionPrompt, setExtensionPrompt] = useState('');
  const [configError, setConfigError] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [loadingExecution, setLoadingExecution] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<QueuedMessage[]>(() => conversationDrafts.get(selectedConversationId ?? 'new')?.queued ?? []);
  const [queuePaused, setQueuePaused] = useState(() => conversationDrafts.get(selectedConversationId ?? 'new')?.paused ?? false);
  const [queueSendingId, setQueueSendingId] = useState<string | null>(null);
  // An answer the server has not accepted yet. It is shown at once so the reader sees what they
  // sent; the accepted exchange replaces it, and a rejection returns the text to the composer.
  const [pendingAnswer, setPendingAnswer] = useState<{ id: string; text: string; createdAt: string } | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeValue, setActiveValue] = useState('');
  const [mainConnectionState, setMainConnectionState] = useState<'connected' | 'reconnecting'>('connected');
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const appliedResultIdsRef = useRef(new Set<string>());
  const mainRequestGenerationRef = useRef(0);
  const observedEventRef = useRef({ executionId: '', sequence: 0 });
  const isConfigured = Boolean(agentQuery.data?.providerId && agentQuery.data?.model);

  useEffect(() => {
    if (!agentQuery.data) return;
    setConfigSelection(agentQuery.data.providerId && agentQuery.data.model ? `${agentQuery.data.providerId}::${agentQuery.data.model}` : '');
    setSelectedMcpServerIds(agentQuery.data.mcpServers.map((server) => server.id));
    setSelectedSkillIds(agentQuery.data.skills.map((skill) => skill.id));
    setExtensionPrompt(agentQuery.data.chatConfiguration?.extensionPrompt ?? '');
  }, [agentQuery.data]);

  const saveConfiguration = async (selection: string, mcpServerIds: string[], skillIds = selectedSkillIds, prompt = extensionPrompt) => {
    if (configSaving) return;
    const separator = selection.indexOf('::');
    setConfigSaving(true);
    setConfigError('');
    try {
      const saved = await api.updateAgent(workspaceSlug, CHAT_AGENT_ID, {
        providerId: separator >= 0 ? selection.slice(0, separator) : null,
        model: separator >= 0 ? selection.slice(separator + 2) : '', mcpServerIds, skillIds,
        extensionPrompt: prompt, expectedConfigurationRevision: agentQuery.data?.chatConfiguration?.revision,
      });
      queryClient.setQueryData(['agent', CHAT_AGENT_ID], saved);
    } catch (cause) {
      setConfigError(apiErrorMessage(cause, t('assistant:configuration.saveFailed')));
      if (agentQuery.data) {
        setConfigSelection(agentQuery.data.providerId && agentQuery.data.model ? `${agentQuery.data.providerId}::${agentQuery.data.model}` : '');
        setSelectedMcpServerIds(agentQuery.data.mcpServers.map((server) => server.id));
        setSelectedSkillIds(agentQuery.data.skills.map((skill) => skill.id));
      }
    } finally { setConfigSaving(false); }
  };

  function openSettings(section: 'channels' | 'configuration') {
    setSettingsSection(section);
    setSettingsOpen(true);
    void navigate({ to: '/chat', search: { view: section, conversation: selectedConversationId ?? undefined } });
  }

  function handleSettingsOpenChange(open: boolean) {
    setSettingsOpen(open);
    if (!open) void navigate({ to: '/chat', search: { view: 'conversation', conversation: selectedConversationId ?? undefined } });
  }

  function changeSettingsSection(value: string) {
    if (value !== 'channels' && value !== 'configuration') return;
    setSettingsSection(value);
    void navigate({ to: '/chat', search: { view: value, conversation: selectedConversationId ?? undefined } });
  }

  function selectConversation(id: string | null) {
    ++mainRequestGenerationRef.current;
    observedEventRef.current = { executionId: '', sequence: 0 };
    conversationDrafts.set(selectedConversationId ?? 'new', { draft, queued, paused: queuePaused });
    const remembered = id ? conversationDrafts.get(id) : undefined;
    if (!id) conversationDrafts.delete('new');
    pendingDispatch.current = null;
    setSelectedConversationId(id);
    setActiveId(null);
    setExecution(null);
    setWorkflowRun(null);
    setBusy(false);
    setCancelling(false);
    setQueueSendingId(null);
    setPendingAnswer(null);
    setLoadingExecution(Boolean(id));
    if (!id) setRecordsOpen(false);
    setQueued(remembered?.queued ?? []);
    setDraft(remembered?.draft ?? '');
    setQueuePaused(remembered?.paused ?? false);
    setError('');
    setSwitcherOpen(false);
    setSettingsOpen(false);
    void navigate({ to: '/chat', search: { view: 'conversation', conversation: id ?? undefined } });
  }

  useEffect(() => {
    conversationDrafts.set(selectedConversationId ?? 'new', { draft, queued, paused: queuePaused });
  }, [selectedConversationId, draft, queued, queuePaused]);

  useEffect(() => () => { ++mainRequestGenerationRef.current; }, []);

  useEffect(() => {
    try {
      if (selectedConversationId) window.localStorage.setItem('worklite.chat.selected', selectedConversationId);
      else window.localStorage.removeItem('worklite.chat.selected');
    } catch { /* Server history remains authoritative. */ }
  }, [selectedConversationId]);

  useEffect(() => {
    const id = typeof locationSearch.conversation === 'string' ? locationSearch.conversation : null;
    if (id && id !== selectedConversationId) selectConversation(id);
    if (locationSearch.view === 'configuration' || locationSearch.view === 'channels') {
      setSettingsSection(locationSearch.view);
      setSettingsOpen(true);
    } else setSettingsOpen(false);
    // URL state is authoritative; conversation switching owns the selected-id dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationSearch.conversation, locationSearch.view]);

  useEffect(() => {
    const data = conversationQuery.data;
    if (!data) return;
    if (data.execution && data.execution.id !== activeId) {
      appliedResultIdsRef.current = new Set(data.execution.toolCalls.filter((call) => call.status === 'completed').map((call) => call.id));
    }
    setActiveId(data.conversation.executionId);
    setExecution((current) => mergeExecutionSnapshot(current, data.execution));
    setLoadingExecution(false);
    // activeId only guards the completed-tool result seed when the execution binding changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationQuery.data]);

  const visibleExecution = execution;
  const connectionState = mainConnectionState;
  const running = visibleExecution?.status === 'running';
  const waitingForInput = visibleExecution?.status === 'waiting_for_input';
  const observingExecution = running || waitingForInput;
  const workflowRunning = workflowRun?.run.status === 'queued' || workflowRun?.run.status === 'running' || workflowRun?.run.status === 'paused' || workflowRun?.run.status === 'waiting_for_input';
  const mentionMatch = !selectedWorkflow && !workflowRunning ? /(?:^|\s)@([^\s@]*)$/.exec(draft) : null;
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase() ?? '';
  const eligibleWorkflows = useMemo(() => (workflowsQuery.data ?? []).filter((workflow) => workflow.state === 'published' && workflow.latestVersionId), [workflowsQuery.data]);
  const mentionMatches = mentionMatch && !mentionDismissed
    ? eligibleWorkflows.filter((workflow) => workflow.name.toLocaleLowerCase().includes(mentionQuery))
    : [];
  const mentionMenuOpen = Boolean(mentionMatch && !mentionDismissed);
  const slashQuery = draft.trimStart().toLowerCase();
  const commandMatches = !selectedWorkflow && !mentionMenuOpen && !workflowRunning && slashQuery.startsWith('/') && !slashDismissed
    ? SLASH_COMMANDS.filter((command) => command.value.startsWith(slashQuery))
    : [];
  const commandMenuOpen = !selectedWorkflow && !mentionMenuOpen && !workflowRunning && slashQuery.startsWith('/') && !slashDismissed;

  const executionError = visibleExecution?.errorCode === 'incomplete_tool_request' || visibleExecution?.error === INCOMPLETE_SKILL_REQUEST
    ? t('assistant:execution.incompleteSkillRequest')
    : visibleExecution?.errorCode === 'invalid_tool_request' || visibleExecution?.error === INVALID_SKILL_REQUEST
      ? t('assistant:execution.invalidSkillRequest')
      : visibleExecution?.errorCode === 'provider' || visibleExecution?.error === GENERIC_AGENT_ERROR
        ? t('assistant:execution.providerRequestFailed')
        : visibleExecution?.errorCode === 'invalid_request' || visibleExecution?.error === AGENT_TURN_ERROR
          ? t('assistant:execution.requestFailed')
          : visibleExecution?.errorCode === 'skill' || visibleExecution?.error === SKILL_EXECUTION_ERROR
            ? t('assistant:execution.skillFailed')
            : visibleExecution?.errorCode === 'restarted' || visibleExecution?.error === RESTARTED_AGENT_ERROR
              ? t('assistant:execution.restarted')
              : visibleExecution?.error ?? '';

  const applyCompletedResult = useCallback(async (call: AgentToolCallView, executionId: string) => {
    const generation = mainRequestGenerationRef.current;
    const result = call.result;
    if (!result) return;
    if (result.type === 'resource') {
      const queryKey = result.resourceType === 'provider' ? 'model-providers' : result.resourceType === 'mcp-server' ? 'mcp-servers' : `${result.resourceType}s`;
      await queryClient.invalidateQueries({ queryKey: [queryKey] });
      return;
    }
    if (result.type === 'settings') {
      const saved = await api.settings();
      queryClient.setQueryData(['settings'], saved);
      applyAppearancePreference(saved.appearance);
      return;
    }
    if (result.type === 'navigation') {
      const snapshot = await api.chatConversation(executionId);
      if (generation !== mainRequestGenerationRef.current) return;
      const turn = snapshot.submissions.filter((submission) => submission.reference?.kind === 'conversation' && submission.executionId === executionId).at(-1);
      if ((turn?.origin ?? snapshot.conversation.channel) === 'web') void navigate({ to: result.route as never });
    }
  }, [applyAppearancePreference, navigate]);

  const applyCompletedResults = useCallback(async (next: AgentExecutionView) => {
    for (const call of next.toolCalls) {
      if (call.status !== 'completed' || appliedResultIdsRef.current.has(call.id)) continue;
      appliedResultIdsRef.current.add(call.id);
      await applyCompletedResult(call, next.id);
    }
  }, [applyCompletedResult]);

  useEffect(() => {
    let cancelled = false;
    const generation = mainRequestGenerationRef.current;
    let retryTimer: number | undefined;
    if (!activeId) {
      setExecution(null);
      setLoadingExecution(false);
      setMainConnectionState('connected');
      return;
    }
    setLoadingExecution(true);
    let delay = 1_500;
    const load = async () => {
      if (cancelled || generation !== mainRequestGenerationRef.current) return;
      try {
        const { execution: next } = await api.chatConversation(activeId);
        if (!next) throw new Error(t('assistant:execution.loadFailed'));
        if (cancelled || generation !== mainRequestGenerationRef.current) return;
        for (const call of next.toolCalls) if (call.status === 'completed') appliedResultIdsRef.current.add(call.id);
        setMainConnectionState('connected');
        setError('');
        setExecution((current) => mergeExecutionSnapshot(current, next));
      } catch (loadError) {
        if (cancelled || generation !== mainRequestGenerationRef.current) return;
        if (loadError instanceof ApiError && loadError.status < 500) {
          setMainConnectionState('connected');
          setError(apiErrorMessage(loadError, t('assistant:execution.loadFailed')));
          return;
        }
        setMainConnectionState('reconnecting');
        retryTimer = window.setTimeout(load, delay);
        delay = Math.min(delay * 2, 12_000);
      } finally {
        if (!cancelled) setLoadingExecution(false);
      }
    };
    void load();
    return () => { cancelled = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [activeId, t, workspaceSlug]);

  useEffect(() => {
    if (!activeId || !observingExecution) return;
    if (observedEventRef.current.executionId !== activeId) observedEventRef.current = { executionId: activeId, sequence: 0 };
    let closed = false;
    const source = new EventSource(api.agentExecutionEventsUrl(CHAT_AGENT_ID, activeId), { withCredentials: true });
    source.onopen = () => setMainConnectionState('connected');
    source.onerror = () => setMainConnectionState('reconnecting');
    source.onmessage = (message) => {
      if (closed) return;
      try {
        const event = parseAgentExecutionEvent(message.data);
        if (event.executionId !== activeId || (event.sequence > 0 && event.sequence <= observedEventRef.current.sequence)) return;
        if (event.sequence > 0) observedEventRef.current.sequence = event.sequence;
        const data = event.data;
        if (data.kind === 'snapshot') {
          setExecution((current) => mergeExecutionSnapshot(current, data.execution));
          void applyCompletedResults(data.execution);
        } else if (data.kind === 'message_delta') {
          setExecution((current) => {
            if (!current) return current;
            const existing = current.messages.find((item) => item.id === data.messageId);
            const messages = existing
              ? current.messages.map((item) => item.id === data.messageId ? { ...item, content: item.content + data.delta } : item)
              : [...current.messages, { id: data.messageId, role: 'assistant' as const, content: data.delta, createdAt: event.createdAt }];
            return { ...current, messages };
          });
        }
      } catch {
        setMainConnectionState('reconnecting');
      }
    };
    return () => { closed = true; source.close(); };
  }, [activeId, applyCompletedResults, observingExecution]);

  const workflowRunId = workflowRun?.run.id;
  useEffect(() => {
    if (!workflowRunId || !workflowRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.run(workspaceSlug, workflowRunId);
        if (!cancelled) setWorkflowRun((current) => current && current.run.id === next.id ? { ...current, run: next } : current);
      } catch {
        // The run remains visible and can be refreshed from the Runs surface.
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    void poll();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [workflowRunId, workflowRunning, workspaceSlug]);

  // A queued message belongs to the turn after the current one. Sending it while the
  // execution is failed, cancelled by the reader, or waiting on a clarification would
  // either waste a call on a missing result or answer the wrong question, so the queue
  // holds its entries instead of draining them.
  useEffect(() => {
    if (queued.length === 0 || queuePaused || busy || !activeId) return;
    if (visibleExecution?.status !== 'completed') return;
    const [next] = queued;
    const generation = mainRequestGenerationRef.current;
    const send = async () => {
      setBusy(true);
      setQueueSendingId(next.id);
      try {
        const result = await sendConversation(next.text, activeId, undefined, next.id);
        if (generation !== mainRequestGenerationRef.current) return;
        setQueued((current) => current.filter((item) => item.id !== next.id));
        setExecution(result);
        void applyCompletedResults(result);
      } catch (sendError) {
        if (generation !== mainRequestGenerationRef.current) return;
        setQueuePaused(true);
        setError(apiErrorMessage(sendError, t('assistant:execution.requestFailed')));
      } finally {
        if (generation === mainRequestGenerationRef.current) { setBusy(false); setQueueSendingId(null); }
      }
    };
    void send();
  }, [activeId, applyCompletedResults, busy, queued, queuePaused, sendConversation, t, visibleExecution?.status, workspaceSlug]);

  useEffect(() => {
    if (visibleExecution?.status === 'failed' || visibleExecution?.status === 'cancelled' || visibleExecution?.status === 'waiting_for_input') setQueuePaused(true);
  }, [visibleExecution?.status]);

  function showPendingAnswer(text: string) {
    setPendingAnswer({ id: `pending_${crypto.randomUUID()}`, text, createdAt: new Date().toISOString() });
  }

  function enqueue(text: string) {
    setQueued((current) => [...current, { id: `web_${crypto.randomUUID()}`, text }]);
    setDraft('');
    setSlashDismissed(false);
    setMentionDismissed(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedMessage = draft.trim();
    if (busy || cancelling || (!trimmedMessage && !selectedWorkflow)) return;
    const generation = mainRequestGenerationRef.current;
    const command = trimmedMessage.toLowerCase();
    if (command === '/log' || command === '/new' || command === '/resume') {
      runCommand(command);
      return;
    }
    if (selectedWorkflow) {
      if (!selectedWorkflow.latestVersionId) return;
      setBusy(true);
      setError('');
      try {
        const created = await dispatchRequest({ message: trimmedMessage, target: { kind: 'workflow', workflowId: selectedWorkflow.id }, executionId: activeId });
        if (created.reference.kind !== 'workflow') throw new Error(t('assistant:workflowRun.requestFailed'));
        const run = await api.run(workspaceSlug, created.reference.runId);
        void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
        void queryClient.invalidateQueries({ queryKey: ['chat-conversation'] });
        if (generation !== mainRequestGenerationRef.current) return;
        pendingDispatch.current = null;
        if (!activeId) {
          setSelectedConversationId(created.submissionId);
          void navigate({ to: '/chat', search: { view: 'conversation', conversation: created.submissionId } });
        }
        setWorkflowRun({ workflow: selectedWorkflow, run, input: trimmedMessage });
        setSelectedWorkflow(null);
        setDraft('');
        setMentionDismissed(false);
      } catch (runError) {
        if (generation !== mainRequestGenerationRef.current) return;
        setError(apiErrorMessage(runError, t('assistant:workflowRun.requestFailed')));
      } finally {
        if (generation === mainRequestGenerationRef.current) setBusy(false);
      }
      return;
    }
    if (waitingForInput && visibleExecution?.pendingQuestion) {
      setBusy(true);
      setError('');
      showPendingAnswer(trimmedMessage);
      setDraft('');
      try {
        const next = await sendConversation(trimmedMessage, visibleExecution.id, visibleExecution.pendingQuestion.id);
        if (generation !== mainRequestGenerationRef.current) return;
        setExecution(next);
        setQueuePaused(false);
      } catch (answerError) {
        if (generation !== mainRequestGenerationRef.current) return;
        // Only an empty composer receives the answer back, so text typed meanwhile is never replaced.
        setDraft((current) => current || trimmedMessage);
        setError(apiErrorMessage(answerError, t('assistant:execution.answerFailed')));
      } finally {
        if (generation === mainRequestGenerationRef.current) { setBusy(false); setPendingAnswer(null); }
      }
      return;
    }
    if (!isConfigured) return;
    if (running) {
      enqueue(trimmedMessage);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await sendConversation(trimmedMessage, activeId);
      if (generation !== mainRequestGenerationRef.current) return;
      setSelectedConversationId(next.id);
      void navigate({ to: '/chat', search: { view: 'conversation', conversation: next.id } });
      setActiveId(next.id);
      setExecution(next);
      void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
      setQueuePaused(false);
      void applyCompletedResults(next);
      setDraft('');
    } catch (requestError) {
      if (generation !== mainRequestGenerationRef.current) return;
      setError(apiErrorMessage(requestError, t('assistant:execution.requestFailed')));
    } finally {
      if (generation === mainRequestGenerationRef.current) setBusy(false);
    }
  }

  async function cancelExecution() {
    if (cancelling) return;
    const cancelWorkflow = workflowRunning && workflowRun;
    if (!cancelWorkflow && (!visibleExecution || !['running', 'waiting_for_input'].includes(visibleExecution.status) || visibleExecution.pendingQuestion?.recovery)) return;
    const generation = ++mainRequestGenerationRef.current;
    setCancelling(true);
    setError('');
    setQueuePaused(true);
    try {
      if (cancelWorkflow) {
        const run = await api.cancelRun(workspaceSlug, cancelWorkflow.run.id);
        if (generation !== mainRequestGenerationRef.current) return;
        setWorkflowRun((current) => current ? { ...current, run } : current);
      } else {
        const next = await api.cancelAgentExecution(workspaceSlug, CHAT_AGENT_ID, visibleExecution!.id);
        if (generation !== mainRequestGenerationRef.current) return;
        setExecution((current) => {
          if (!current || current.id !== next.id) return next;
          const ids = new Set(next.messages.map((message) => message.id));
          return { ...next, messages: [...next.messages, ...current.messages.filter((message) => message.role === 'assistant' && !ids.has(message.id))] };
        });
        void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
        void queryClient.invalidateQueries({ queryKey: ['chat-conversation'] });
      }
    } catch (cancelError) {
      if (generation !== mainRequestGenerationRef.current) return;
      setError(apiErrorMessage(cancelError, t(cancelWorkflow ? 'assistant:workflowRun.cancelFailed' : 'assistant:execution.cancelFailed')));
    } finally {
      if (generation === mainRequestGenerationRef.current) { setBusy(false); setCancelling(false); }
    }
  }

  async function retryExecution() {
    if (!visibleExecution || visibleExecution.status !== 'failed' || busy) return;
    const generation = mainRequestGenerationRef.current;
    setBusy(true);
    setError('');
    try {
      const next = await api.retryAgentExecution(workspaceSlug, CHAT_AGENT_ID, visibleExecution.id);
      if (generation !== mainRequestGenerationRef.current) return;
      setExecution(next);
      setMainConnectionState('connected');
      setQueuePaused(false);
    } catch (retryError) {
      if (generation !== mainRequestGenerationRef.current) return;
      setError(apiErrorMessage(retryError, t('assistant:execution.requestFailed')));
    } finally {
      if (generation === mainRequestGenerationRef.current) setBusy(false);
    }
  }

  function selectMention(workflow: WorkflowView) {
    if (!mentionMatch) return;
    const atIndex = draft.lastIndexOf('@');
    setDraft(atIndex >= 0 ? draft.slice(0, atIndex) : draft);
    setSelectedWorkflow(workflow);
    setMentionDismissed(true);
  }

  function runCommand(command: SlashCommand) {
    if (command === '/new' || command === '/resume') pendingDispatch.current = null;
    setDraft('');
    setSlashDismissed(true);
    if (command === '/log') {
      if (!execution) {
        setError(t('assistant:log.noActive'));
        return;
      }
      setError('');
      downloadExecutionLog(execution, {
        title: t('assistant:log.title'),
        generated: t('assistant:log.generated'),
        executionId: t('assistant:log.executionId'),
        phase: t('assistant:log.phase'),
        errorCode: t('assistant:log.errorCode'),
        status: t('assistant:log.status'),
        incomplete: t('assistant:log.incomplete'),
        reason: t('assistant:log.reason'),
        cancelledReason: t('assistant:log.cancelledReason'),
        transcript: t('assistant:log.transcript'),
        noMessages: t('assistant:log.noMessages'),
        user: t('assistant:log.user'),
        assistant: t('assistant:log.assistant'),
        activity: t('assistant:log.activity'),
        noActivity: t('assistant:log.noActivity'),
        skill: t('assistant:log.skill'),
        script: t('assistant:log.script'),
        toolCallId: t('assistant:log.toolCallId'),
        commandExecutionId: t('assistant:log.commandExecutionId'),
        exitCode: t('assistant:log.exitCode'),
        statuses: {
          running: t('assistant:log.statuses.running'),
          waiting_for_input: t('assistant:log.statuses.waiting_for_input'),
          completed: t('assistant:log.statuses.completed'),
          cancelled: t('assistant:log.statuses.cancelled'),
          failed: t('assistant:log.statuses.failed'),
        },
      }, locale, executionError);
      return;
    }
    if (command === '/new') {
      selectConversation(null);
      return;
    }
    setSwitcherOpen(true);
  }

  // Escape dismisses exactly one layer per press, innermost first, so recovering from a
  // mistyped slash never also discards a chosen Workflow or collapses the conversation.
  function handleEscape(): boolean {
    if (commandMenuOpen || mentionMenuOpen) {
      setSlashDismissed(true);
      setMentionDismissed(true);
      return true;
    }
    if (selectedWorkflow) {
      setSelectedWorkflow(null);
      return true;
    }
    return false;
  }


  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      if (handleEscape()) event.preventDefault();
      return;
    }
    if (selectedWorkflow && !draft && event.key === 'Backspace') {
      setSelectedWorkflow(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (mentionMenuOpen) {
        const workflow = mentionMatches.find((item) => `mention:${item.id}` === activeValue) ?? mentionMatches[0];
        if (workflow) selectMention(workflow);
        return;
      }
      if (commandMenuOpen) {
        const command = commandMatches.find((item) => item.value === activeValue) ?? commandMatches[0];
        if (command) runCommand(command.value);
        return;
      }
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (!menuNavigationKey(event.key) || !(commandMenuOpen || mentionMenuOpen)) return;
    const values = mentionMenuOpen ? mentionMatches.map((item) => `mention:${item.id}`) : commandMatches.map((item) => item.value);
    if (values.length === 0) return;
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const currentIndex = Math.max(0, values.indexOf(activeValue));
    setActiveValue(values[(currentIndex + offset + values.length) % values.length]);
  }

  async function answerChoice(answer: string, authorization?: Pick<DispatchChatRequest, 'recoveryDecision' | 'newConversation'>) {
    if (!execution?.pendingQuestion || busy) return;
    const generation = mainRequestGenerationRef.current;
    setBusy(true); setError('');
    // Accepting a new conversation is navigation, not an answer, so it has no answer message.
    if (!authorization?.newConversation) showPendingAnswer(answer);
    try {
      const next = await sendConversation(answer, execution.id, execution.pendingQuestion.id, undefined, authorization);
      if (generation !== mainRequestGenerationRef.current) return;
      if (authorization?.newConversation) { selectConversation(next.id); return; }
      setExecution(next); setQueuePaused(false);
      void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
    } catch (cause) { if (generation === mainRequestGenerationRef.current) setError(apiErrorMessage(cause, t('assistant:execution.answerFailed'))); }
    finally { if (generation === mainRequestGenerationRef.current) { setBusy(false); setPendingAnswer(null); } }
  }

  const transcriptHostRef = useRef<HTMLDivElement>(null);
  const pinTracking = usePinTracking(transcriptHostRef);
  const submissions = conversationQuery.data?.submissions ?? [];
  const timeline = buildTimeline({
    execution: visibleExecution,
    submissions,
    workflowRun: workflowRun && !submissions.some((submission) => submission.reference?.kind === 'workflow' && submission.reference.runId === workflowRun.run.id) ? workflowRun : null,
    receipts: conversationQuery.data?.pendingReceipts ?? [],
    question: waitingForInput ? visibleExecution?.pendingQuestion ?? null : null,
    cancelled: visibleExecution?.status === 'cancelled',
    failed: visibleExecution?.status === 'failed',
  });
  // The event stream can report the accepted answer before its request returns; once the question
  // is no longer pending, the stored exchange represents the answer instead.
  const visiblePendingAnswer = waitingForInput ? pendingAnswer : null;
  const lastEntry = timeline[timeline.length - 1];
  const showWorkingInLastTurn = running && lastEntry?.kind === 'assistant';
  const pinCandidates: PinCandidate[] = timeline.flatMap((entry): PinCandidate[] => entry.kind === 'task'
    ? [{ id: entry.submission.id, kind: 'submission', submission: entry.submission }]
    : entry.kind === 'workflowRun'
      ? [{ id: entry.active.run.id, kind: 'workflowRun', run: entry.active.run, name: entry.active.workflow.name }]
      : entry.kind === 'assistant'
        ? entry.segments.flatMap((segment): PinCandidate[] => segment.kind === 'tool' && segment.item.projectTask ? [{ id: segment.item.projectTask.id, kind: 'project', task: segment.item.projectTask }] : [])
        : []);

  // The header badge reports server execution state only. A submission the server has
  // not accepted yet is reported by the Send control, not as a running execution.
  const headerStatus: { key: StatusKey; label: string } | null = workflowRun?.run.status === 'queued' ? { key: 'queued', label: t('assistant:status.queued') }
    : workflowRun?.run.status === 'running' ? { key: 'running', label: t('assistant:status.running') }
    : workflowRun?.run.status === 'paused' ? { key: 'paused', label: t('assistant:status.paused') }
    : workflowRun?.run.status === 'waiting_for_input' ? { key: 'waiting_for_input', label: t('assistant:workflowRun.waitingForConfirmation') }
    : connectionState === 'reconnecting' ? { key: 'pending', label: t('assistant:status.reconnecting') }
    : visibleExecution?.status === 'failed' ? { key: 'failed', label: t('assistant:status.failed') }
      : visibleExecution?.status === 'cancelled' ? { key: 'cancelled', label: t('assistant:status.cancelled') }
        : visibleExecution?.status === 'completed' ? { key: 'completed', label: t('assistant:status.completed') }
          : visibleExecution?.status === 'waiting_for_input' ? { key: 'waiting_for_input', label: t('assistant:status.waiting_for_input') }
            : visibleExecution?.status === 'running' ? { key: 'running', label: t('assistant:status.running') } : null;
  const canCancel = Boolean(workflowRunning || ((running || waitingForInput) && !visibleExecution?.pendingQuestion?.recovery));
  const composerAvailable = Boolean(isConfigured || eligibleWorkflows.length > 0 || canCancel);
  const composerLoading = agentQuery.isLoading || workflowsQuery.isLoading || mcpServersQuery.isLoading;
  const stopTarget = running || workflowRunning;
  const submitDisabled = stopTarget ? cancelling : busy || cancelling || (!draft.trim() && !selectedWorkflow && !stopTarget) || (!selectedWorkflow && !stopTarget && !isConfigured);

  const selected = conversationQuery.data?.conversation;
  const selectedWithoutExecution = Boolean(selectedConversationId && !activeId);
  const loadingConversation = !visibleExecution && !conversationQuery.isError && (conversationQuery.isLoading || loadingExecution);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        crumbs={[{ label: 'Chat' }]}
        status={headerStatus ? <StatusBadge key={headerStatus.key} status={headerStatus.key} label={headerStatus.label} /> : undefined}
        actions={(
          <Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:settings.open')} onClick={() => openSettings('channels')}>
            <Settings className="size-4" />
          </Button>
        )}
      />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 border-r border-border bg-surface md:flex"><ConversationList selectedId={selectedConversationId} onSelect={selectConversation} onNew={() => selectConversation(null)} /></aside>
        <section ref={chatSurfaceRef} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('assistant:title')}>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
              <Button variant="ghost" size="icon-compact" className="md:hidden" aria-label={t('assistant:history.title')} onClick={() => setSwitcherOpen(true)}><List className="size-4" /></Button>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{selected?.title || t(selectedConversationId ? 'assistant:history.loading' : 'assistant:history.new')}</p><p className="truncate text-xs text-muted-foreground">{selected?.channel === 'feishu' ? t(conversationQuery.data?.channelDelivery === 'unbound' ? 'assistant:channels.feishuUnbound' : conversationQuery.data?.channelDelivery === 'disconnected' ? 'assistant:channels.feishuDisconnected' : 'assistant:channels.feishuBound') : 'Web'}</p></div>
              <Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:history.new')} onClick={() => selectConversation(null)} className="md:hidden"><Plus className="size-4" /></Button>
              {selectedConversationId ? <Button type="button" variant="ghost" size="compact" aria-expanded={recordsOpen} onClick={() => setRecordsOpen((value) => !value)}><ScrollText className="size-4" />{t('assistant:records.title')}</Button> : null}
            </header>
            <div ref={transcriptHostRef} className="relative min-h-0 flex-1">
              <PinTrackingContext.Provider value={pinTracking.context}>
              {recordsOpen ? null : <PinnedExecutionBar candidates={pinCandidates} above={pinTracking.above} onReveal={pinTracking.reveal} />}
              <div className="flex h-full min-h-0 flex-col" inert={recordsOpen} aria-hidden={recordsOpen}>
              <Conversation className="min-h-0 flex-1 px-4 md:px-8" scrollToEndLabel={t('assistant:transcript.scrollToEnd')}>
                <ConversationContent className="mx-auto w-full max-w-3xl">
                  {loadingConversation ? <TranscriptSkeleton /> : null}
                  {conversationQuery.isError ? <div className="space-y-2"><p role="alert" className="text-sm text-danger">{t('assistant:history.loadFailed')}</p><Button variant="secondary" size="compact" onClick={() => void conversationQuery.refetch()}>{t('assistant:history.retry')}</Button></div> : null}
                  {timeline.map((entry, index) => {
                    switch (entry.kind) {
                      case 'user': return <UserMessage key={entry.item.id} message={entry.item} />;
                      case 'assistant': return <AssistantTurn key={entry.segments[0].item.id} segments={entry.segments} working={showWorkingInLastTurn && index === timeline.length - 1} markdownEnabled />;
                      case 'task': return <TaskCard key={entry.submission.id} submission={entry.submission} />;
                      case 'workflowRun': return <WorkflowRunRow key={entry.active.run.id} run={entry.active.run} workflow={entry.active.workflow} input={entry.active.input} />;
                      case 'receipt': return <div key={entry.receipt.id} className="my-3 space-y-2"><UserMessage message={{ id: entry.receipt.id, role: 'user', content: entry.receipt.text, createdAt: entry.receipt.createdAt }} /><p role={entry.receipt.error ? 'alert' : 'status'} className={cn('text-[13px]', entry.receipt.error ? 'text-danger' : 'text-muted-foreground')}>{entry.receipt.error || t('assistant:status.queued')}</p></div>;
                      case 'question': return <QuestionNote key={entry.question.id} question={entry.question} onAnswer={(answer, authorization) => void answerChoice(answer, authorization)} busy={busy || cancelling} />;
                      case 'cancelled': return <CancelledNote key="cancelled" />;
                      case 'failure': return <FailureNote key="failure" execution={visibleExecution} message={executionError || t('assistant:execution.requestFailed')} onRetry={() => void retryExecution()} retryDisabled={busy || cancelling} locale={locale} />;
                    }
                  })}
                  {visiblePendingAnswer ? <UserMessage key={visiblePendingAnswer.id} message={{ id: visiblePendingAnswer.id, role: 'user', content: visiblePendingAnswer.text, createdAt: visiblePendingAnswer.createdAt }} pending /> : null}
                  {(running && !showWorkingInLastTurn || busy && !cancelling && !running && (!waitingForInput || visiblePendingAnswer)) ? <AssistantTurn segments={[]} working markdownEnabled /> : null}
                  <QueueRows queued={queued} paused={queuePaused} sendingId={queueSendingId} onRemove={(id) => setQueued((current) => current.filter((item) => item.id !== id))} />
                  {error ? <p className="wl-enter mt-4 rounded-md border border-danger/25 bg-danger-subtle px-3 py-2 text-[13px] text-danger" role="alert">{error}</p> : null}
                </ConversationContent>
              </Conversation>
              </div>
              </PinTrackingContext.Provider>
              {recordsOpen && selectedConversationId ? <div className="absolute inset-0 z-10 flex flex-col bg-background"><ConversationRecords conversationId={selectedConversationId} /></div> : null}
            </div>
            {recordsOpen ? null : loadingConversation || composerLoading ? <p className="px-4 py-3 text-[13px] text-muted-foreground" role="status">{t('assistant:composer.loading')}</p> : selectedWithoutExecution ? <p className="border-t border-border px-4 py-3 text-[13px] text-muted-foreground">{t(selected?.channel === 'feishu' ? 'assistant:channels.waiting' : 'assistant:history.taskRecord')}</p> : composerAvailable ? (
              <Composer draft={draft} onDraftChange={(value) => { setDraft(value); setSlashDismissed(false); setMentionDismissed(false); setActiveValue(''); }} onSubmit={submit} onKeyDown={handleComposerKeyDown} onFocus={() => {}}
                selectedWorkflow={selectedWorkflow} onRemoveWorkflow={() => setSelectedWorkflow(null)} commandMatches={commandMatches} commandMenuOpen={commandMenuOpen} onRunCommand={runCommand}
                mentionMatches={mentionMatches} mentionMenuOpen={mentionMenuOpen} onSelectMention={selectMention} activeValue={activeValue} onActiveValueChange={setActiveValue}
                onDismissMenus={() => { setSlashDismissed(true); setMentionDismissed(true); }} running={stopTarget} busy={busy || cancelling} canCancel={canCancel} cancelling={cancelling} submitDisabled={submitDisabled} waitingForInput={Boolean(waitingForInput)} onStop={() => void cancelExecution()} />
            ) : <div className="px-4 pb-4 md:px-8"><button type="button" className={cn('wl-press mx-auto flex min-h-12 w-full max-w-3xl items-center gap-2.5 rounded-xl border border-warning/30 bg-warning-subtle px-4 text-left text-[13px] font-medium text-foreground shadow-xs hover:border-warning/50', focusRingInset)} onClick={() => openSettings('configuration')}><ShieldAlert className="size-4 text-warning" />{t('assistant:composer.configure')}<ChevronRight className="ml-auto size-4" /></button></div>}
        </section>
      </div>
      <Sheet open={switcherOpen} onOpenChange={setSwitcherOpen}><SheetContent side="left" className="flex w-80 flex-col p-0 pt-10 sm:max-w-80"><SheetHeader className="sr-only"><SheetTitle>{t('assistant:history.title')}</SheetTitle></SheetHeader><ConversationList selectedId={selectedConversationId} onSelect={selectConversation} onNew={() => selectConversation(null)} /></SheetContent></Sheet>
      <Dialog open={settingsOpen} onOpenChange={handleSettingsOpenChange}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>{t('assistant:settings.title')}</DialogTitle>
            <DialogDescription>{t('assistant:settings.description')}</DialogDescription>
          </DialogHeader>
          <Tabs value={settingsSection} onValueChange={changeSettingsSection} className="min-h-0 flex-1 flex-col gap-0">
            <div className="px-6 pt-2">
              <TabsList>
                <TabsTrigger value="channels">{t('assistant:settings.channels')}</TabsTrigger>
                <TabsTrigger value="configuration">{t('assistant:settings.configuration')}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="channels" className="min-h-0 flex-1 overflow-y-auto">
              <ChannelConfiguration onOpenWeb={() => selectConversation(null)} />
            </TabsContent>
            <TabsContent value="configuration" className="min-h-0 flex-1 overflow-y-auto">
              <Configuration providers={providersQuery.data ?? []} mcpServers={mcpServersQuery.data ?? []} selection={configSelection}
                onSelectionChange={(value) => { setConfigSelection(value); void saveConfiguration(value, selectedMcpServerIds); }}
                selectedMcpServerIds={selectedMcpServerIds} onMcpServersChange={(ids) => { setSelectedMcpServerIds(ids); void saveConfiguration(configSelection, ids); }}
                skills={skillsQuery.data ?? []} selectedSkillIds={selectedSkillIds} onSkillsChange={(ids) => { setSelectedSkillIds(ids); void saveConfiguration(configSelection, selectedMcpServerIds, ids); }}
                extensionPrompt={extensionPrompt} onPromptChange={setExtensionPrompt} onPromptSave={() => { if (extensionPrompt !== (agentQuery.data?.chatConfiguration?.extensionPrompt ?? '')) void saveConfiguration(configSelection, selectedMcpServerIds); }}
                saving={configSaving} error={configError} loading={agentQuery.isLoading || providersQuery.isLoading || skillsQuery.isLoading || mcpServersQuery.isLoading}
                loadFailed={agentQuery.isError || providersQuery.isError || skillsQuery.isError || mcpServersQuery.isError}
                onReload={() => { void agentQuery.refetch(); void providersQuery.refetch(); void skillsQuery.refetch(); void mcpServersQuery.refetch(); }} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function menuNavigationKey(key: string) {
  return key === 'ArrowDown' || key === 'ArrowUp';
}

export { ChatWorkspace };
