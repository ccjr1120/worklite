import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Brain, ChevronRight, Cpu, List, Plus, Radio, ScrollText, Settings, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CompositionEvent as ReactCompositionEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, ChatConversationView, ChatSubmissionView, DispatchChatRequest, ProjectExecutor, RunView, WorkflowView } from '@worklite/contracts';
import { ApiError, api, parseAgentExecutionEvent } from '@/api/client';
import { chatConversationsQueryKey, useAgentQuery, useModelProvidersQuery, useSkillsQuery, useWorkflowsQuery } from '@/api/queries';
import { Conversation, ConversationContent } from '@/components/ai-elements/conversation';
import { useLocale } from '@/components/locale-provider';
import { useTheme } from '@/components/theme-provider';
import { StatusBadge, type StatusKey } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { focusRingInset } from '@/components/ui/interaction';
import { queryClient } from '@/lib/query-client';
import { cn } from '@/lib/utils';
import { Composer, SLASH_COMMANDS, type SlashCommand } from './composer';
import { clearNewConversationDraft, readChatDraft, writeChatDraft } from './draft-storage';
import { Configuration } from './configuration';
import { ExecutorsConfiguration } from './executors-configuration';
import { Memories } from './memories';
import { downloadExecutionLog } from './execution-log';
import { ConversationList } from './conversation-list';
import { ConversationRecords } from './records';
import { ChannelConfiguration } from './channel-configuration';
import { TaskCard } from './task-messages';
import { PinnedExecutionBar, PinTrackingContext, usePinTracking, type PinCandidate } from './pinned-executions';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CHAT_AGENT_ID } from '@worklite/contracts';
import { AssistantTurn, buildTimeline, CancelledNote, FailureNote, ProgressReportExpansionContext, QuestionNote, QueueRows, SummaryDivider, TranscriptSkeleton, UserMessage, WorkflowRunRow } from './transcript';

const INCOMPLETE_SKILL_REQUEST = 'The model returned an incomplete Skill request. Its JSON ended before the request was complete.';
const INVALID_SKILL_REQUEST = 'The model returned an invalid Skill request. Its arguments could not be parsed or did not match the required structure.';
const GENERIC_AGENT_ERROR = 'Chat could not complete this turn. Check its provider configuration and try again.';
const AGENT_TURN_ERROR = 'Chat could not complete this turn.';
const SKILL_EXECUTION_ERROR = 'The Skill script could not be completed.';
const RESTARTED_AGENT_ERROR = 'The API restarted before this Chat turn completed.';

type QueuedMessage = { id: string; text: string };
type ActiveWorkflowRun = { workflow: WorkflowView; run: RunView; input: string };
type PendingReceipt = ChatConversationView['pendingReceipts'][number];
// A declared executor default is one model id, an ordered fallback list, or absent; the editor
// represents both forms as one comma-separated text field.
function modelListToText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}
function textToModelList(value: string): string | string[] | null {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  return entries.length === 1 ? entries[0]! : entries;
}
const conversationDrafts = new Map<string, { draft: string; queued: QueuedMessage[]; paused: boolean }>();
const NO_SUBMISSIONS: ChatSubmissionView[] = [];
const NO_RECEIPTS: PendingReceipt[] = [];
// The transcript mounts only the newest entries until the reader asks for the rest, so opening a
// long conversation does not mount its whole history at once.
const RECENT_TIMELINE_COUNT = 30;

type SettingsSection = 'channels' | 'configuration' | 'executors' | 'memories';
// The settings Dialog switches sections through a slim left rail rather than top tabs;
// each entry keeps its validated `view=` deep link of the same name.
const SETTINGS_SECTIONS: { value: SettingsSection; icon: typeof SlidersHorizontal }[] = [
  { value: 'configuration', icon: SlidersHorizontal },
  { value: 'executors', icon: Cpu },
  { value: 'channels', icon: Radio },
  { value: 'memories', icon: Brain },
];
// Chrome delivers the composition-confirming Enter keydown while isComposing is still true, but
// WebKit — Safari and the desktop WKWebView shell — fires compositionend before that keydown, so
// isComposing is already false when it arrives. Both events belong to one IME confirmation
// gesture and are dispatched back to back, so an Enter landing within this window of
// compositionend is still a candidate confirmation and must not send.
const COMPOSITION_ENTER_GUARD_MS = 30;

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
  const skillsQuery = useSkillsQuery(workspaceSlug);
  const workflowsQuery = useWorkflowsQuery(workspaceSlug);
  const { applyAppearancePreference } = useTheme();
  const { locale } = useLocale();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(() => typeof locationSearch.conversation === 'string' ? locationSearch.conversation : readSelectedConversation());
  const [conversationView, setConversationView] = useState<ChatConversationView | null>(null);
  const [conversationFailed, setConversationFailed] = useState(false);
  const [conversationReloadKey, setConversationReloadKey] = useState(0);
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
    return execution;
  }, [dispatchRequest, workspaceSlug]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [execution, setExecution] = useState<AgentExecutionView | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowView | null>(null);
  const [workflowRun, setWorkflowRun] = useState<ActiveWorkflowRun | null>(null);
  const [draft, setDraft] = useState(() => readChatDraft(selectedConversationId) ?? conversationDrafts.get(selectedConversationId ?? 'new')?.draft ?? '');
  const [settingsOpen, setSettingsOpen] = useState(locationSearch.view === 'channels' || locationSearch.view === 'configuration' || locationSearch.view === 'executors' || locationSearch.view === 'memories');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(locationSearch.view === 'channels' || locationSearch.view === 'configuration' || locationSearch.view === 'executors' || locationSearch.view === 'memories' ? locationSearch.view : 'configuration');
  const [configSelection, setConfigSelection] = useState('');
  const [defaultExecutor, setDefaultExecutor] = useState<ProjectExecutor>('claude');
  // '' means the executor's own local default; a non-empty comma-separated list declares one model
  // or an ordered list of fallback candidates (first entry tried first).
  const [executorModels, setExecutorModels] = useState<Record<ProjectExecutor, string>>({ claude: '', codex: '' });
  const [configSaving, setConfigSaving] = useState(false);
  const [extensionPrompt, setExtensionPrompt] = useState('');
  const [executorContext, setExecutorContext] = useState('');
  const [projectTaskMcpServerIds, setProjectTaskMcpServerIds] = useState<string[]>([]);
  const [summarizePrompt, setSummarizePrompt] = useState('');
  const [chatSkillIds, setChatSkillIds] = useState<string[]>([]);
  const [configError, setConfigError] = useState('');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  // Progress report cards default to their compact line; the reader's expand choice is one
  // conversation-level state shared by every card and resets when the conversation changes.
  const [progressReportsExpanded, setProgressReportsExpanded] = useState(false);
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
  const imeCompositionRef = useRef({ active: false, endedAt: -Infinity });
  const isConfigured = Boolean(agentQuery.data?.providerId && agentQuery.data?.model);

  useEffect(() => {
    if (!agentQuery.data) return;
    setConfigSelection(agentQuery.data.providerId && agentQuery.data.model ? `${agentQuery.data.providerId}::${agentQuery.data.model}` : '');
    setDefaultExecutor(agentQuery.data.chatConfiguration?.defaultExecutor ?? 'claude');
    setExtensionPrompt(agentQuery.data.chatConfiguration?.extensionPrompt ?? '');
    setExecutorContext(agentQuery.data.chatConfiguration?.executorContext ?? '');
    setProjectTaskMcpServerIds(agentQuery.data.chatConfiguration?.projectTaskMcpServerIds ?? []);
    setSummarizePrompt(agentQuery.data.chatConfiguration?.summarizePrompt ?? '');
    setChatSkillIds(agentQuery.data.chatConfiguration?.skillIds ?? []);
    setExecutorModels({
      claude: modelListToText(agentQuery.data.chatConfiguration?.defaultExecutorModels?.claude),
      codex: modelListToText(agentQuery.data.chatConfiguration?.defaultExecutorModels?.codex),
    });
  }, [agentQuery.data]);

  const saveConfiguration = async (selection: string, prompt = extensionPrompt, models = executorModels, summarize = summarizePrompt, skillIds?: string[], sharedExecutorContext = executorContext, executor = defaultExecutor, mcpServerIds?: string[]) => {
    if (configSaving) return;
    const separator = selection.indexOf('::');
    setConfigSaving(true);
    setConfigError('');
    try {
      const saved = await api.updateAgent(workspaceSlug, CHAT_AGENT_ID, {
        providerId: separator >= 0 ? selection.slice(0, separator) : null,
        model: separator >= 0 ? selection.slice(separator + 2) : '',
        extensionPrompt: prompt, executorContext: sharedExecutorContext, summarizePrompt: summarize, defaultExecutor: executor, expectedConfigurationRevision: agentQuery.data?.chatConfiguration?.revision,
        // Both declarations are current state; selecting the default only turns the chosen one into null.
        defaultExecutorModels: { claude: textToModelList(models.claude), codex: textToModelList(models.codex) },
        ...(mcpServerIds === undefined ? {} : { projectTaskMcpServerIds: mcpServerIds }),
        ...(skillIds === undefined ? {} : { skillIds }),
      });
      queryClient.setQueryData(['agent', CHAT_AGENT_ID], saved);
    } catch (cause) {
      setConfigError(apiErrorMessage(cause, t('assistant:configuration.saveFailed')));
      if (agentQuery.data) {
        setConfigSelection(agentQuery.data.providerId && agentQuery.data.model ? `${agentQuery.data.providerId}::${agentQuery.data.model}` : '');
        setDefaultExecutor(agentQuery.data.chatConfiguration?.defaultExecutor ?? 'claude');
        setExtensionPrompt(agentQuery.data.chatConfiguration?.extensionPrompt ?? '');
        setExecutorContext(agentQuery.data.chatConfiguration?.executorContext ?? '');
        setProjectTaskMcpServerIds(agentQuery.data.chatConfiguration?.projectTaskMcpServerIds ?? []);
        setSummarizePrompt(agentQuery.data.chatConfiguration?.summarizePrompt ?? '');
        setChatSkillIds(agentQuery.data.chatConfiguration?.skillIds ?? []);
        setExecutorModels({
          claude: modelListToText(agentQuery.data.chatConfiguration?.defaultExecutorModels?.claude),
          codex: modelListToText(agentQuery.data.chatConfiguration?.defaultExecutorModels?.codex),
        });
      }
    } finally { setConfigSaving(false); }
  };

  function changeExecutorModel(executor: ProjectExecutor, value: string) {
    const nextModels = { ...executorModels, [executor]: value };
    setExecutorModels(nextModels);
    if (value !== modelListToText(agentQuery.data?.chatConfiguration?.defaultExecutorModels?.[executor])) {
      void saveConfiguration(configSelection, extensionPrompt, nextModels);
    }
  }

  function changeDefaultExecutor(executor: ProjectExecutor) {
    setDefaultExecutor(executor);
    if (executor !== (agentQuery.data?.chatConfiguration?.defaultExecutor ?? 'claude')) {
      void saveConfiguration(configSelection, extensionPrompt, executorModels, summarizePrompt, undefined, executorContext, executor);
    }
  }

  function changeProjectTaskMcpServerIds(ids: string[]) {
    setProjectTaskMcpServerIds(ids);
    void saveConfiguration(configSelection, extensionPrompt, executorModels, summarizePrompt, undefined, executorContext, defaultExecutor, ids);
  }

  function openSettings(section: SettingsSection) {
    setSettingsSection(section);
    setSettingsOpen(true);
    void navigate({ to: '/chat', search: { view: section, conversation: selectedConversationId ?? undefined } });
  }

  function handleSettingsOpenChange(open: boolean) {
    setSettingsOpen(open);
    if (!open) void navigate({ to: '/chat', search: { view: 'conversation', conversation: selectedConversationId ?? undefined } });
  }

  function changeSettingsSection(value: SettingsSection) {
    setSettingsSection(value);
    void navigate({ to: '/chat', search: { view: value, conversation: selectedConversationId ?? undefined } });
  }

  function selectConversation(id: string | null, options?: { discardDraft?: boolean }) {
    ++mainRequestGenerationRef.current;
    observedEventRef.current = { executionId: '', sequence: 0 };
    if (options?.discardDraft) {
      // A slash command is not composer content: retire the text instead of carrying it
      // into the conversation being left, where it would come back as a restored draft.
      conversationDrafts.set(selectedConversationId ?? 'new', { draft: '', queued, paused: queuePaused });
      writeChatDraft(selectedConversationId, '');
    } else {
      conversationDrafts.set(selectedConversationId ?? 'new', { draft, queued, paused: queuePaused });
      // Persist the outgoing draft at switch time as well, so the next keystroke is never
      // required before the draft is safe on disk.
      writeChatDraft(selectedConversationId, draft);
    }
    // Read the entry before dropping the new-conversation slot: its draft has to return
    // when the reader comes back to a conversation the server has not created yet.
    const remembered = conversationDrafts.get(id ?? 'new');
    if (!id) conversationDrafts.delete('new');
    pendingDispatch.current = null;
    setSelectedConversationId(id);
    setActiveId(null);
    setExecution(null);
    setConversationView(null);
    setConversationFailed(false);
    setShowAllTimeline(false);
    setWorkflowRun(null);
    setBusy(false);
    setCancelling(false);
    setQueueSendingId(null);
    setPendingAnswer(null);
    setLoadingExecution(Boolean(id));
    if (!id) setRecordsOpen(false);
    setQueued(remembered?.queued ?? []);
    setDraft(readChatDraft(id) ?? remembered?.draft ?? '');
    setQueuePaused(remembered?.paused ?? false);
    setError('');
    setSwitcherOpen(false);
    setSettingsOpen(false);
    void navigate({ to: '/chat', search: { view: 'conversation', conversation: id ?? undefined } });
  }

  useEffect(() => {
    conversationDrafts.set(selectedConversationId ?? 'new', { draft, queued, paused: queuePaused });
    // Keystone of draft persistence: every composer edit belongs to the conversation that
    // is selected right now, so a route change, reload or conversation switch can restore it.
    writeChatDraft(selectedConversationId, draft);
  }, [selectedConversationId, draft, queued, queuePaused]);

  useEffect(() => () => { ++mainRequestGenerationRef.current; }, []);

  useEffect(() => { setProgressReportsExpanded(false); }, [selectedConversationId]);

  useEffect(() => {
    try {
      if (selectedConversationId) window.localStorage.setItem('worklite.chat.selected', selectedConversationId);
      else window.localStorage.removeItem('worklite.chat.selected');
    } catch { /* Server history remains authoritative. */ }
  }, [selectedConversationId]);

  useEffect(() => {
    const id = typeof locationSearch.conversation === 'string' ? locationSearch.conversation : null;
    if (id && id !== selectedConversationId) selectConversation(id);
    if (locationSearch.view === 'configuration' || locationSearch.view === 'executors' || locationSearch.view === 'channels' || locationSearch.view === 'memories') {
      setSettingsSection(locationSearch.view);
      setSettingsOpen(true);
    } else setSettingsOpen(false);
    // URL state is authoritative; conversation switching owns the selected-id dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationSearch.conversation, locationSearch.view]);

  const currentView = conversationView && conversationView.conversation.id === selectedConversationId ? conversationView : null;

  // The conversation view loads through one manual path with generation cancellation and
  // exponential backoff; a settled load polls on the former query interval so channel-side
  // activity keeps arriving without a second request path.
  useEffect(() => {
    if (!selectedConversationId) {
      setConversationView(null);
      setConversationFailed(false);
      return;
    }
    let cancelled = false;
    const generation = mainRequestGenerationRef.current;
    let retryTimer: number | undefined;
    let delay = 1_500;
    setConversationFailed(false);
    const load = async () => {
      if (cancelled || generation !== mainRequestGenerationRef.current) return;
      try {
        const view = await api.chatConversation(selectedConversationId);
        if (cancelled || generation !== mainRequestGenerationRef.current) return;
        setMainConnectionState('connected');
        setError('');
        setConversationView(view);
        retryTimer = window.setTimeout(load, 5_000);
      } catch (loadError) {
        if (cancelled || generation !== mainRequestGenerationRef.current) return;
        if (loadError instanceof ApiError && loadError.status < 500) {
          setMainConnectionState('connected');
          setConversationFailed(true);
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
  }, [selectedConversationId, conversationReloadKey, t]);

  useEffect(() => {
    if (!currentView) return;
    if (currentView.execution && currentView.execution.id !== activeId) {
      appliedResultIdsRef.current = new Set(currentView.execution.toolCalls.filter((call) => call.status === 'completed').map((call) => call.id));
    }
    setActiveId(currentView.conversation.executionId);
    setExecution((current) => mergeExecutionSnapshot(current, currentView.execution));
    setLoadingExecution(false);
    // activeId only guards the completed-tool result seed when the execution binding changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);

  const visibleExecution = execution;
  const connectionState = mainConnectionState;
  const running = visibleExecution?.status === 'running';
  const waitingForInput = visibleExecution?.status === 'waiting_for_input';
  // Background project tasks keep the stream open after their turn settles so progress and the
  // automatic report turn arrive live.
  const activeProjectTasks = Boolean(visibleExecution?.toolCalls.some((call) => call.projectTask && (call.projectTask.status === 'running' || call.projectTask.status === 'waiting_for_input')));
  const observingExecution = running || waitingForInput || activeProjectTasks;
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
            const messagePresentation = data.progressReport ? { progressReport: data.progressReport } : {};
            const messages = existing
              ? current.messages.map((item) => item.id === data.messageId ? { ...item, content: item.content + data.delta, ...messagePresentation } : item)
              : [...current.messages, { id: data.messageId, role: 'assistant' as const, content: data.delta, createdAt: event.createdAt, ...messagePresentation }];
            return { ...current, messages };
          });
        }
      } catch {
        setMainConnectionState('reconnecting');
      }
    };
    // A deliberately closed stream is not a lost connection; don't leave the header reconnecting.
    return () => { closed = true; source.close(); setMainConnectionState('connected'); };
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
    if (command === '/log' || command === '/new' || command === '/resume' || command === '/summarize') {
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
        if (generation !== mainRequestGenerationRef.current) return;
        pendingDispatch.current = null;
        if (!activeId) {
          setSelectedConversationId(created.submissionId);
          void navigate({ to: '/chat', search: { view: 'conversation', conversation: created.submissionId } });
        }
        setWorkflowRun({ workflow: selectedWorkflow, run, input: trimmedMessage });
        setSelectedWorkflow(null);
        setDraft('');
        // A workflow dispatch from the new-conversation composer created a conversation;
        // retire the temporary draft so the next new conversation starts empty.
        if (!selectedConversationId) {
          conversationDrafts.delete('new');
          clearNewConversationDraft();
        }
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
    const fromNewConversation = selectedConversationId === null;
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
      // The accepted message now belongs to the created conversation, so the new-conversation
      // slot must not keep a copy that would surface when the reader starts another chat.
      if (fromNewConversation) {
        conversationDrafts.delete('new');
        clearNewConversationDraft();
      }
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
    if (!cancelWorkflow && (!visibleExecution || (!['running', 'waiting_for_input'].includes(visibleExecution.status) && !activeProjectTasks) || visibleExecution.pendingQuestion?.recovery)) return;
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
    if (command === '/new' || command === '/resume' || command === '/summarize') pendingDispatch.current = null;
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
      selectConversation(null, { discardDraft: true });
      return;
    }
    if (command === '/summarize') {
      void summarizeCurrent();
      return;
    }
    setSwitcherOpen(true);
  }

  // Summarizing compresses the current conversation in place: the server replaces the
  // execution's model context with the summary and appends a persisted divider, and the
  // returned snapshot refreshes the transcript without leaving the page.
  async function summarizeCurrent() {
    if (busy || cancelling) return;
    if (!visibleExecution) {
      setError(t('assistant:summarize.empty'));
      return;
    }
    const generation = mainRequestGenerationRef.current;
    setBusy(true);
    setError('');
    try {
      const next = await api.summarizeChatConversation(visibleExecution.id);
      if (generation !== mainRequestGenerationRef.current) return;
      setExecution(next);
      void queryClient.invalidateQueries({ queryKey: chatConversationsQueryKey });
    } catch (cause) {
      if (generation !== mainRequestGenerationRef.current) return;
      setError(apiErrorMessage(cause, t('assistant:summarize.failed')));
    } finally {
      if (generation === mainRequestGenerationRef.current) setBusy(false);
    }
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


  function handleCompositionStart() {
    imeCompositionRef.current.active = true;
  }

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLTextAreaElement>) {
    imeCompositionRef.current.active = false;
    imeCompositionRef.current.endedAt = event.timeStamp;
  }

  function isImeComposing(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.nativeEvent.isComposing || imeCompositionRef.current.active) return true;
    return event.timeStamp - imeCompositionRef.current.endedAt < COMPOSITION_ENTER_GUARD_MS;
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
      if (isImeComposing(event)) return;
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
  const progressReportExpansion = useMemo(() => ({ expanded: progressReportsExpanded, toggle: () => setProgressReportsExpanded((value) => !value) }), [progressReportsExpanded]);
  const submissions = currentView?.submissions ?? NO_SUBMISSIONS;
  const receipts = currentView?.pendingReceipts ?? NO_RECEIPTS;
  const timeline = useMemo(() => buildTimeline({
    execution: visibleExecution,
    submissions,
    workflowRun: workflowRun && !submissions.some((submission) => submission.reference?.kind === 'workflow' && submission.reference.runId === workflowRun.run.id) ? workflowRun : null,
    receipts,
    question: waitingForInput ? visibleExecution?.pendingQuestion ?? null : null,
    cancelled: visibleExecution?.status === 'cancelled',
    failed: visibleExecution?.status === 'failed',
  }), [visibleExecution, submissions, workflowRun, receipts, waitingForInput]);
  const hiddenTimelineCount = !showAllTimeline && timeline.length > RECENT_TIMELINE_COUNT ? timeline.length - RECENT_TIMELINE_COUNT : 0;
  const visibleTimeline = hiddenTimelineCount > 0 ? timeline.slice(hiddenTimelineCount) : timeline;
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
  const canCancel = Boolean(workflowRunning || ((running || waitingForInput || activeProjectTasks) && !visibleExecution?.pendingQuestion?.recovery));
  const composerAvailable = Boolean(isConfigured || eligibleWorkflows.length > 0 || canCancel);
  const composerLoading = agentQuery.isLoading || workflowsQuery.isLoading;
  const stopTarget = running || workflowRunning;
  const submitDisabled = stopTarget ? cancelling : busy || cancelling || (!draft.trim() && !selectedWorkflow && !stopTarget) || (!selectedWorkflow && !stopTarget && !isConfigured);

  const selected = currentView?.conversation;
  const selectedWithoutExecution = Boolean(selectedConversationId && !activeId);
  const loadingConversation = !visibleExecution && !conversationFailed && loadingExecution;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceChrome
        crumbs={[{ label: 'Chat' }]}
        status={headerStatus ? <StatusBadge key={headerStatus.key} status={headerStatus.key} label={headerStatus.label} /> : undefined}
        actions={(
          <Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:settings.open')} onClick={() => openSettings('configuration')}>
            <Settings className="size-4" />
          </Button>
        )}
      />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 border-r border-border bg-surface md:flex"><ConversationList selectedId={selectedConversationId} onSelect={selectConversation} onNew={() => selectConversation(null)} /></aside>
        <section ref={chatSurfaceRef} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('assistant:title')}>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
              <Button variant="ghost" size="icon-compact" className="md:hidden" aria-label={t('assistant:history.title')} onClick={() => setSwitcherOpen(true)}><List className="size-4" /></Button>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold" title={selected?.title || undefined}>{selected?.title || t(selectedConversationId ? 'assistant:history.loading' : 'assistant:history.new')}</p><p className="truncate text-xs text-muted-foreground">{selected?.channel === 'feishu' || selected?.channel === 'wechat' ? t(currentView?.channelDelivery === 'unbound' ? `assistant:channels.${selected.channel}Unbound` : currentView?.channelDelivery === 'disconnected' ? `assistant:channels.${selected.channel}Disconnected` : `assistant:channels.${selected.channel}Bound`) : 'Web'}</p></div>
              <Button type="button" variant="ghost" size="icon-compact" aria-label={t('assistant:history.new')} onClick={() => selectConversation(null)} className="md:hidden"><Plus className="size-4" /></Button>
              {selectedConversationId ? <Button type="button" variant="ghost" size="compact" aria-expanded={recordsOpen} onClick={() => setRecordsOpen((value) => !value)}><ScrollText className="size-4" />{t('assistant:records.title')}</Button> : null}
            </header>
            <div ref={transcriptHostRef} className="relative min-h-0 flex-1">
              <PinTrackingContext.Provider value={pinTracking.context}>
              <ProgressReportExpansionContext.Provider value={progressReportExpansion}>
              {recordsOpen ? null : <PinnedExecutionBar candidates={pinCandidates} above={pinTracking.above} onReveal={pinTracking.reveal} />}
              <div className="flex h-full min-h-0 flex-col" inert={recordsOpen} aria-hidden={recordsOpen}>
              <Conversation className="min-h-0 flex-1 px-4 md:px-8" scrollToEndLabel={t('assistant:transcript.scrollToEnd')}>
                <ConversationContent className="mx-auto w-full max-w-3xl">
                  {loadingConversation ? <TranscriptSkeleton /> : null}
                  {conversationFailed ? <div className="space-y-2"><p role="alert" className="text-sm text-danger">{t('assistant:history.loadFailed')}</p><Button variant="secondary" size="compact" onClick={() => { setConversationFailed(false); setLoadingExecution(true); setConversationReloadKey((key) => key + 1); }}>{t('assistant:history.retry')}</Button></div> : null}
                  {hiddenTimelineCount > 0 ? <div className="flex justify-center"><Button type="button" variant="secondary" size="compact" onClick={() => setShowAllTimeline(true)}>{t('assistant:transcript.showEarlier', { count: hiddenTimelineCount })}</Button></div> : null}
                  {visibleTimeline.map((entry, index) => {
                    switch (entry.kind) {
                      case 'user': return <UserMessage key={entry.item.id} message={entry.item} />;
                      case 'summaryDivider': return <SummaryDivider key={entry.item.id} label={t('assistant:summarize.divider')} message={entry.item} />;
                      case 'assistant': return <AssistantTurn key={entry.segments[0].item.id} segments={entry.segments} working={showWorkingInLastTurn && index === visibleTimeline.length - 1} markdownEnabled />;
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
              </ProgressReportExpansionContext.Provider>
              </PinTrackingContext.Provider>
              {recordsOpen && selectedConversationId ? <div className="absolute inset-0 z-10 flex flex-col bg-background"><ConversationRecords conversationId={selectedConversationId} /></div> : null}
            </div>
            {recordsOpen ? null : loadingConversation || composerLoading ? <p className="px-4 py-3 text-[13px] text-muted-foreground" role="status">{t('assistant:composer.loading')}</p> : selectedWithoutExecution ? <p className="border-t border-border px-4 py-3 text-[13px] text-muted-foreground">{t(selected?.channel === 'feishu' || selected?.channel === 'wechat' ? 'assistant:channels.waiting' : 'assistant:history.taskRecord')}</p> : composerAvailable ? (
              <Composer draft={draft} onDraftChange={(value) => { setDraft(value); setSlashDismissed(false); setMentionDismissed(false); setActiveValue(''); }} onSubmit={submit} onKeyDown={handleComposerKeyDown} onFocus={() => {}}
                onCompositionStart={handleCompositionStart} onCompositionEnd={handleCompositionEnd}
                selectedWorkflow={selectedWorkflow} onRemoveWorkflow={() => setSelectedWorkflow(null)} commandMatches={commandMatches} commandMenuOpen={commandMenuOpen} onRunCommand={runCommand}
                mentionMatches={mentionMatches} mentionMenuOpen={mentionMenuOpen} onSelectMention={selectMention} activeValue={activeValue} onActiveValueChange={setActiveValue}
                onDismissMenus={() => { setSlashDismissed(true); setMentionDismissed(true); }} running={stopTarget} busy={busy || cancelling} canCancel={canCancel} cancelling={cancelling} submitDisabled={submitDisabled} waitingForInput={Boolean(waitingForInput)} onStop={() => void cancelExecution()} />
            ) : <div className="px-4 pb-4 md:px-8"><button type="button" className={cn('wl-press mx-auto flex min-h-12 w-full max-w-3xl items-center gap-2.5 rounded-xl border border-warning/30 bg-warning-subtle px-4 text-left text-[13px] font-medium text-foreground shadow-xs hover:border-warning/50', focusRingInset)} onClick={() => openSettings('configuration')}><ShieldAlert className="size-4 text-warning" />{t('assistant:composer.configure')}<ChevronRight className="ml-auto size-4" /></button></div>}
        </section>
      </div>
      <Sheet open={switcherOpen} onOpenChange={setSwitcherOpen}><SheetContent side="left" className="flex w-80 flex-col p-0 pt-10 sm:max-w-80"><SheetHeader className="sr-only"><SheetTitle>{t('assistant:history.title')}</SheetTitle></SheetHeader><ConversationList selectedId={selectedConversationId} onSelect={selectConversation} onNew={() => selectConversation(null)} /></SheetContent></Sheet>
      <Dialog open={settingsOpen} onOpenChange={handleSettingsOpenChange}>
        <DialogContent className="flex h-[min(40rem,85vh)] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>{t('assistant:settings.title')}</DialogTitle>
            <DialogDescription>{t('assistant:settings.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1">
            <nav aria-label={t('assistant:settings.title')} className="flex w-14 shrink-0 flex-col gap-1 px-3 pb-6 pt-4 sm:w-44">
              {SETTINGS_SECTIONS.map((section) => {
                const selected = settingsSection === section.value;
                return (
                  <button
                    key={section.value}
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    aria-label={t(`assistant:settings.${section.value}`)}
                    onClick={() => changeSettingsSection(section.value)}
                    className={cn(
                      'wl-press flex items-center justify-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] sm:justify-start',
                      selected ? 'bg-brand-subtle font-semibold' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
                      focusRingInset,
                    )}
                  >
                    <section.icon className={cn('size-4 shrink-0', selected && 'text-brand-text')} aria-hidden="true" />
                    <span className="hidden truncate sm:inline">{t(`assistant:settings.${section.value}`)}</span>
                  </button>
                );
              })}
            </nav>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-l border-border [scrollbar-gutter:stable]">
              {settingsSection === 'channels' ? <ChannelConfiguration /> : null}
              {settingsSection === 'configuration' ? (
                <Configuration providers={providersQuery.data ?? []} skills={skillsQuery.data ?? []} selectedSkillIds={chatSkillIds}
                  onSkillIdsChange={(ids) => { setChatSkillIds(ids); void saveConfiguration(configSelection, extensionPrompt, executorModels, summarizePrompt, ids); }}
                  skillsLoading={skillsQuery.isLoading} skillsLoadFailed={skillsQuery.isError}
                  selection={configSelection}
                  onSelectionChange={(value) => { setConfigSelection(value); void saveConfiguration(value); }}
                  extensionPrompt={extensionPrompt} onPromptChange={setExtensionPrompt} onPromptSave={() => { if (extensionPrompt !== (agentQuery.data?.chatConfiguration?.extensionPrompt ?? '')) void saveConfiguration(configSelection); }}
                  summarizePrompt={summarizePrompt} onSummarizePromptChange={setSummarizePrompt} onSummarizePromptSave={() => { if (summarizePrompt !== (agentQuery.data?.chatConfiguration?.summarizePrompt ?? '')) void saveConfiguration(configSelection); }}
                  saving={configSaving} error={configError} loading={agentQuery.isLoading}
                  loadFailed={agentQuery.isError} providersLoading={providersQuery.isLoading} providersLoadFailed={providersQuery.isError}
                  onReload={() => { void agentQuery.refetch(); void providersQuery.refetch(); void skillsQuery.refetch(); }} />
              ) : null}
              {settingsSection === 'executors' ? (
                <ExecutorsConfiguration providers={providersQuery.data ?? []}
                  defaultExecutor={defaultExecutor} onDefaultExecutorChange={changeDefaultExecutor}
                  executorModels={executorModels} onExecutorModelChange={changeExecutorModel}
                  executorContext={executorContext} onExecutorContextChange={setExecutorContext} onExecutorContextSave={() => { if (executorContext !== (agentQuery.data?.chatConfiguration?.executorContext ?? '')) void saveConfiguration(configSelection, extensionPrompt, executorModels, summarizePrompt, undefined, executorContext); }}
                  projectTaskMcpServerIds={projectTaskMcpServerIds} onProjectTaskMcpServerIdsChange={changeProjectTaskMcpServerIds}
                  saving={configSaving} error={configError} loading={agentQuery.isLoading}
                  loadFailed={agentQuery.isError} providersLoading={providersQuery.isLoading} providersLoadFailed={providersQuery.isError}
                  onReload={() => { void agentQuery.refetch(); void providersQuery.refetch(); }} />
              ) : null}
              {settingsSection === 'memories' ? <Memories /> : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function menuNavigationKey(key: string) {
  return key === 'ArrowDown' || key === 'ArrowUp';
}

export { ChatWorkspace };
