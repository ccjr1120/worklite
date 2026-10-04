import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronRight, List, Plus, ScrollText, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, DispatchChatRequest, RunView, WorkflowView } from '@worklite/contracts';
import { ApiError, api, parseAgentExecutionEvent } from '@/api/client';
import { chatConversationsQueryKey, useAgentQuery, useChatConversationQuery, useMcpServersQuery, useModelProvidersQuery, useSkillsQuery, useWorkflowsQuery } from '@/api/queries';
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { Badge } from '@/components/ui/badge';
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
import { TaskMessages } from './task-messages';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CHAT_AGENT_ID } from '@worklite/contracts';
import { AssistantTurn, CancelledNote, FailureNote, groupTurns, QuestionNote, QueueRows, TranscriptSkeleton, UserMessage, WorkflowRunRow } from './transcript';

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
  const sendConversation = useCallback(async (message: string, executionId: string | null, questionId?: string, submissionId?: string) => {
    const input = { message, target: { kind: 'conversation' as const }, executionId, ...(questionId ? { questionId } : {}) };
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
  const [panelView, setPanelView] = useState<'chat' | 'channels' | 'configuration'>(locationSearch.view === 'channels' ? 'channels' : locationSearch.view === 'configuration' ? 'configuration' : 'chat');
  const [configSelection, setConfigSelection] = useState('');
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [configSaving, setConfigSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [extensionPrompt, setExtensionPrompt] = useState('');
  const [configError, setConfigError] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingExecution, setLoadingExecution] = useState(false);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState<QueuedMessage[]>(() => conversationDrafts.get(selectedConversationId ?? 'new')?.queued ?? []);
  const [queuePaused, setQueuePaused] = useState(() => conversationDrafts.get(selectedConversationId ?? 'new')?.paused ?? false);
  const [queueSendingId, setQueueSendingId] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [activeValue, setActiveValue] = useState('');
  const [mainConnectionState, setMainConnectionState] = useState<'connected' | 'reconnecting'>('connected');
  const chatSurfaceRef = useRef<HTMLDivElement>(null);
  const appliedResultIdsRef = useRef(new Set<string>());
  const mainRequestGenerationRef = useRef(0);
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

  function setView(view: 'chat' | 'channels' | 'configuration') {
    setPanelView(view);
    void navigate({ to: '/chat', search: { view: view === 'chat' ? 'conversation' : view, conversation: selectedConversationId ?? undefined } });
  }

  function selectConversation(id: string | null) {
    ++mainRequestGenerationRef.current;
    conversationDrafts.set(selectedConversationId ?? 'new', { draft, queued, paused: queuePaused });
    const remembered = id ? conversationDrafts.get(id) : undefined;
    if (!id) conversationDrafts.delete('new');
    pendingDispatch.current = null;
    setSelectedConversationId(id);
    setActiveId(null);
    setExecution(null);
    setWorkflowRun(null);
    setBusy(false);
    setQueueSendingId(null);
    setLoadingExecution(Boolean(id));
    if (!id) setRecordsOpen(false);
    setQueued(remembered?.queued ?? []);
    setDraft(remembered?.draft ?? '');
    setQueuePaused(remembered?.paused ?? false);
    setError('');
    setSwitcherOpen(false);
    setPanelView('chat');
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
    if (locationSearch.view === 'configuration' || locationSearch.view === 'channels') setPanelView(locationSearch.view);
    else setPanelView('chat');
  }, [locationSearch.conversation, locationSearch.view]);

  useEffect(() => {
    const data = conversationQuery.data;
    if (!data) return;
    if (data.execution && data.execution.id !== activeId) {
      appliedResultIdsRef.current = new Set(data.execution.toolCalls.filter((call) => call.status === 'completed').map((call) => call.id));
    }
    setActiveId(data.conversation.executionId);
    setExecution((current) => current?.id === data.execution?.id && current?.status === 'running' && data.execution?.status === 'running' ? current : data.execution);
    setLoadingExecution(false);
  }, [conversationQuery.data]);

  const visibleExecution = execution;
  const connectionState = mainConnectionState;
  const running = visibleExecution?.status === 'running';
  const waitingForInput = visibleExecution?.status === 'waiting_for_input';
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
    const generation = ++mainRequestGenerationRef.current;
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
        setExecution(next);
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
    if (!activeId || (execution?.status !== 'running' && execution?.status !== 'waiting_for_input')) return;
    const source = new EventSource(api.agentExecutionEventsUrl(CHAT_AGENT_ID, activeId), { withCredentials: true });
    source.onopen = () => setMainConnectionState('connected');
    source.onerror = () => setMainConnectionState('reconnecting');
    source.onmessage = (message) => {
      try {
        const event = parseAgentExecutionEvent(message.data);
        const data = event.data;
        if (data.kind === 'snapshot') {
          setExecution((current) => {
            if (!current || current.id !== data.execution.id || !['failed', 'cancelled'].includes(data.execution.status)) return data.execution;
            const ids = new Set(data.execution.messages.map((entry) => entry.id));
            return { ...data.execution, messages: [...data.execution.messages, ...current.messages.filter((entry) => entry.role === 'assistant' && !ids.has(entry.id))] };
          });
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
    return () => source.close();
  }, [activeId, applyCompletedResults, execution?.status]);

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

  function enqueue(text: string) {
    setQueued((current) => [...current, { id: `web_${crypto.randomUUID()}`, text }]);
    setDraft('');
    setSlashDismissed(false);
    setMentionDismissed(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedMessage = draft.trim();
    if (busy || (!trimmedMessage && !selectedWorkflow)) return;
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
      try {
        const next = await sendConversation(trimmedMessage, visibleExecution.id, visibleExecution.pendingQuestion.id);
        if (generation !== mainRequestGenerationRef.current) return;
        setExecution(next);
        setDraft('');
        setQueuePaused(false);
      } catch (answerError) {
        if (generation !== mainRequestGenerationRef.current) return;
        setError(apiErrorMessage(answerError, t('assistant:execution.answerFailed')));
      } finally {
        if (generation === mainRequestGenerationRef.current) setBusy(false);
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
    const generation = mainRequestGenerationRef.current;
    if (workflowRunning && workflowRun && !busy) {
      setBusy(true);
      setError('');
      try {
        const run = await api.cancelRun(workspaceSlug, workflowRun.run.id);
        if (generation !== mainRequestGenerationRef.current) return;
        setWorkflowRun((current) => current ? { ...current, run } : current);
      } catch (cancelError) {
        if (generation !== mainRequestGenerationRef.current) return;
        setError(apiErrorMessage(cancelError, t('assistant:workflowRun.cancelFailed')));
      } finally {
        if (generation === mainRequestGenerationRef.current) setBusy(false);
      }
      return;
    }
    if (!visibleExecution || visibleExecution.status !== 'running' || busy) return;
    setBusy(true);
    setError('');
    setQueuePaused(true);
    try {
      const next = await api.cancelAgentExecution(workspaceSlug, CHAT_AGENT_ID, visibleExecution.id);
      if (generation !== mainRequestGenerationRef.current) return;
      setExecution(next);
    } catch (cancelError) {
      if (generation !== mainRequestGenerationRef.current) return;
      setError(apiErrorMessage(cancelError, t('assistant:execution.cancelFailed')));
    } finally {
      if (generation === mainRequestGenerationRef.current) setBusy(false);
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
    if (panelView === 'configuration' && isConfigured) {
      setPanelView('chat');
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

  function handlePanelTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const views = ['chat', 'channels', 'configuration'] as const;
    const index = views.indexOf(panelView);
    const next = event.key === 'Home' ? views[0] : event.key === 'End' ? views[2] : views[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
    setView(next);
    window.requestAnimationFrame(() => document.getElementById(`chat-${next}-tab`)?.focus());
  }

  async function answerChoice(answer: string) {
    if (!execution?.pendingQuestion || busy) return;
    const generation = mainRequestGenerationRef.current;
    setBusy(true); setError('');
    try {
      const next = await sendConversation(answer, execution.id, execution.pendingQuestion.id);
      if (generation !== mainRequestGenerationRef.current) return;
      setExecution(next); setQueuePaused(false);
      void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
    } catch (cause) { if (generation === mainRequestGenerationRef.current) setError(apiErrorMessage(cause, t('assistant:execution.answerFailed'))); }
    finally { if (generation === mainRequestGenerationRef.current) setBusy(false); }
  }

  const turns = visibleExecution ? groupTurns(visibleExecution) : [];
  const lastTurn = turns[turns.length - 1];
  const showWorkingInLastTurn = running && lastTurn?.kind === 'assistant';

  // The header badge reports server execution state only. A submission the server has
  // not accepted yet is reported by the Send control, not as a running execution.
  const status = workflowRun?.run.status === 'queued' ? t('assistant:status.queued')
    : workflowRun?.run.status === 'running' ? t('assistant:status.running')
    : workflowRun?.run.status === 'paused' ? t('assistant:status.paused')
    : workflowRun?.run.status === 'waiting_for_input' ? t('assistant:workflowRun.waitingForConfirmation')
    : connectionState === 'reconnecting' ? t('assistant:status.reconnecting')
    : visibleExecution?.status === 'failed' ? t('assistant:status.failed')
      : visibleExecution?.status === 'cancelled' ? t('assistant:status.cancelled')
        : visibleExecution?.status === 'completed' ? t('assistant:status.completed')
          : visibleExecution?.status === 'waiting_for_input' ? t('assistant:status.waiting_for_input')
            : visibleExecution?.status === 'running' ? t('assistant:status.running') : '';
  const composerAvailable = Boolean(isConfigured || eligibleWorkflows.length > 0);
  const composerLoading = agentQuery.isLoading || workflowsQuery.isLoading || mcpServersQuery.isLoading;
  const stopTarget = (running && !selectedWorkflow) || workflowRunning;
  const submitDisabled = busy || (!draft.trim() && !selectedWorkflow && !stopTarget) || (!selectedWorkflow && !stopTarget && !isConfigured);

  const selected = conversationQuery.data?.conversation;
  const selectedWithoutExecution = Boolean(selectedConversationId && !activeId);
  const loadingConversation = !conversationQuery.isError && (conversationQuery.isLoading || loadingExecution);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome crumbs={[{ label: 'Chat' }]} status={status ? <Badge variant={visibleExecution?.status === 'failed' ? 'danger' : 'neutral'}>{status}</Badge> : undefined} />
      <div className="agent-tabs shrink-0" role="tablist" aria-label={t('assistant:panelTabs.label')}>
        {(['chat', 'channels', 'configuration'] as const).map((view) => <button key={view} id={`chat-${view}-tab`} type="button" role="tab" aria-selected={panelView === view} aria-controls={`chat-${view}-content`} tabIndex={panelView === view ? 0 : -1} className={cn(panelView === view && 'active')} onKeyDown={handlePanelTabKeyDown} onClick={() => setView(view)}>{t(`assistant:panelTabs.${view}`)}</button>)}
      </div>
      {panelView === 'channels' ? <div id="chat-channels-content" role="tabpanel" aria-labelledby="chat-channels-tab" className="min-h-0 flex-1 overflow-auto"><ChannelConfiguration onOpenWeb={() => selectConversation(null)} /></div> : panelView === 'configuration' ? (
        <div id="chat-configuration-content" role="tabpanel" aria-labelledby="chat-configuration-tab" className="min-h-0 flex-1 overflow-auto">
          <Configuration providers={providersQuery.data ?? []} mcpServers={mcpServersQuery.data ?? []} selection={configSelection}
            onSelectionChange={(value) => { setConfigSelection(value); void saveConfiguration(value, selectedMcpServerIds); }}
            selectedMcpServerIds={selectedMcpServerIds} onMcpServersChange={(ids) => { setSelectedMcpServerIds(ids); void saveConfiguration(configSelection, ids); }}
            skills={skillsQuery.data ?? []} selectedSkillIds={selectedSkillIds} onSkillsChange={(ids) => { setSelectedSkillIds(ids); void saveConfiguration(configSelection, selectedMcpServerIds, ids); }}
            extensionPrompt={extensionPrompt} onPromptChange={setExtensionPrompt} onPromptSave={() => { if (extensionPrompt !== (agentQuery.data?.chatConfiguration?.extensionPrompt ?? '')) void saveConfiguration(configSelection, selectedMcpServerIds); }}
            saving={configSaving} error={configError} loading={agentQuery.isLoading || providersQuery.isLoading || skillsQuery.isLoading || mcpServersQuery.isLoading}
            loadFailed={agentQuery.isError || providersQuery.isError || skillsQuery.isError || mcpServersQuery.isError}
            onReload={() => { void agentQuery.refetch(); void providersQuery.refetch(); void skillsQuery.refetch(); void mcpServersQuery.refetch(); }} />
        </div>
      ) : (
        <div id="chat-chat-content" role="tabpanel" aria-labelledby="chat-chat-tab" className="flex min-h-0 flex-1">
          <aside className="hidden w-64 shrink-0 border-r border-border md:flex"><ConversationList selectedId={selectedConversationId} onSelect={selectConversation} onNew={() => selectConversation(null)} /></aside>
          <section ref={chatSurfaceRef} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('assistant:panelTabs.chat')}>
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <Button variant="ghost" size="icon-compact" className="md:hidden" aria-label={t('assistant:history.title')} onClick={() => setSwitcherOpen(true)}><List className="size-4" /></Button>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{selected?.title || t(selectedConversationId ? 'assistant:history.loading' : 'assistant:history.new')}</p><p className="text-xs text-muted-foreground">{selected?.channel === 'feishu' ? t(conversationQuery.data?.channelDelivery === 'unbound' ? 'assistant:channels.feishuUnbound' : conversationQuery.data?.channelDelivery === 'disconnected' ? 'assistant:channels.feishuDisconnected' : 'assistant:channels.feishuBound') : 'Web'}</p></div>
              <Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:history.new')} onClick={() => selectConversation(null)} className="md:hidden"><Plus className="size-4" /></Button>
              {selectedConversationId ? <Button type="button" variant="ghost" size="compact" aria-expanded={recordsOpen} onClick={() => setRecordsOpen((value) => !value)}><ScrollText className="size-4" />{t('assistant:records.title')}</Button> : null}
            </header>
            <div className="relative min-h-0 flex-1">
              <div className="flex h-full min-h-0 flex-col" inert={recordsOpen} aria-hidden={recordsOpen}>
              <Conversation className="min-h-0 flex-1 px-4 md:px-6" scrollToEndLabel={t('assistant:transcript.scrollToEnd')}>
                <ConversationContent>
                  {loadingConversation ? <TranscriptSkeleton /> : null}
                  {conversationQuery.isError ? <div className="space-y-2"><p role="alert" className="text-sm text-danger">{t('assistant:history.loadFailed')}</p><Button variant="secondary" size="compact" onClick={() => void conversationQuery.refetch()}>{t('assistant:history.retry')}</Button></div> : null}
                  {turns.map((turn, index) => turn.kind === 'user' ? <UserMessage key={turn.item.id} message={turn.item} /> : <AssistantTurn key={turn.segments[0].item.id} segments={turn.segments} working={showWorkingInLastTurn && index === turns.length - 1} markdownEnabled />)}
                  {(running && !showWorkingInLastTurn || busy && !running && !waitingForInput) ? <AssistantTurn segments={[]} working markdownEnabled /> : null}
                  {waitingForInput && visibleExecution?.pendingQuestion ? <QuestionNote key={visibleExecution.pendingQuestion.id} question={visibleExecution.pendingQuestion} onAnswer={(answer) => void answerChoice(answer)} busy={busy} /> : null}
                  {visibleExecution?.status === 'cancelled' ? <CancelledNote /> : null}
                  <TaskMessages submissions={conversationQuery.data?.submissions ?? []} />
                  {workflowRun && !conversationQuery.data?.submissions.some((submission) => submission.reference?.kind === 'workflow' && submission.reference.runId === workflowRun.run.id) ? <WorkflowRunRow run={workflowRun.run} workflow={workflowRun.workflow} input={workflowRun.input} /> : null}
                  {conversationQuery.data?.pendingReceipts.map((receipt) => <div key={receipt.id} className="my-3 space-y-2"><UserMessage message={{ id: receipt.id, role: 'user', content: receipt.text, createdAt: receipt.createdAt }} /><p role={receipt.error ? 'alert' : 'status'} className={cn('text-[13px]', receipt.error ? 'text-danger' : 'text-muted-foreground')}>{receipt.error || t('assistant:status.queued')}</p></div>)}
                  {executionError ? <FailureNote execution={visibleExecution} message={executionError} onRetry={() => void retryExecution()} retryDisabled={busy} locale={locale} /> : null}
                  <QueueRows queued={queued} paused={queuePaused} sendingId={queueSendingId} onRemove={(id) => setQueued((current) => current.filter((item) => item.id !== id))} />
                  {error ? <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger" role="alert">{error}</p> : null}
                </ConversationContent>
              </Conversation>
              </div>
              {recordsOpen && selectedConversationId ? <div className="absolute inset-0 z-10 flex flex-col bg-background"><ConversationRecords conversationId={selectedConversationId} /></div> : null}
            </div>
            {recordsOpen ? null : loadingConversation || composerLoading ? <p className="px-4 py-3 text-[13px] text-muted-foreground" role="status">{t('assistant:composer.loading')}</p> : selectedWithoutExecution ? <p className="border-t border-border px-4 py-3 text-[13px] text-muted-foreground">{t(selected?.channel === 'feishu' ? 'assistant:channels.waiting' : 'assistant:history.taskRecord')}</p> : composerAvailable ? (
              <Composer draft={draft} onDraftChange={(value) => { setDraft(value); setSlashDismissed(false); setMentionDismissed(false); setActiveValue(''); }} onSubmit={submit} onKeyDown={handleComposerKeyDown} onFocus={() => {}}
                selectedWorkflow={selectedWorkflow} onRemoveWorkflow={() => setSelectedWorkflow(null)} commandMatches={commandMatches} commandMenuOpen={commandMenuOpen} onRunCommand={runCommand}
                mentionMatches={mentionMatches} mentionMenuOpen={mentionMenuOpen} onSelectMention={selectMention} activeValue={activeValue} onActiveValueChange={setActiveValue}
                onDismissMenus={() => { setSlashDismissed(true); setMentionDismissed(true); }} running={stopTarget} busy={busy} submitDisabled={submitDisabled} waitingForInput={Boolean(waitingForInput)} onStop={() => void cancelExecution()} />
            ) : <button type="button" className={cn('flex min-h-12 w-full items-center gap-2 border-t border-border px-4 text-left text-[13px] hover:bg-surface-subtle', focusRingInset)} onClick={() => setView('configuration')}><ShieldAlert className="size-4" />{t('assistant:composer.configure')}<ChevronRight className="ml-auto size-4" /></button>}
          </section>
        </div>
      )}
      <Sheet open={switcherOpen} onOpenChange={setSwitcherOpen}><SheetContent side="left" className="flex w-80 flex-col p-0"><SheetHeader className="sr-only"><SheetTitle>{t('assistant:history.title')}</SheetTitle></SheetHeader><ConversationList selectedId={selectedConversationId} onSelect={selectConversation} onNew={() => selectConversation(null)} /></SheetContent></Sheet>
    </div>
  );
}

function menuNavigationKey(key: string) {
  return key === 'ArrowDown' || key === 'ArrowUp';
}

export { ChatWorkspace };
