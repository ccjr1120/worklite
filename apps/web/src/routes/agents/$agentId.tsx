import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft, ChevronDown, ChevronRight, FileCode2, LoaderCircle, RotateCcw, Send, ShieldAlert, Square } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentExecutionView, AgentToolCallView, McpServerView, ModelProviderView, SkillView } from '@worklite/contracts';
import { api } from '@/api/client';
import {
  agentsQueryKey,
  useAgentQuery,
  useMcpServersQuery,
  useModelProvidersQuery,
  useSkillsQuery,
} from '@/api/queries';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { StreamingMarkdown } from '@/components/ai/streaming-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { queryClient } from '@/lib/query-client';

export const Route = createFileRoute('/agents/$agentId')({
  component: AgentEditorPage,
});

function AgentEditorPage() {
  const { t } = useTranslation(['agents', 'common']);
  const { agentId } = Route.useParams();
  const workspaceSlug = 'personal';
  const isNew = agentId === 'new';
  const agentQuery = useAgentQuery(workspaceSlug, agentId);
  const providersQuery = useModelProvidersQuery(workspaceSlug);
  const skillsQuery = useSkillsQuery(workspaceSlug);
  const mcpServersQuery = useMcpServersQuery(workspaceSlug);
  const existing = agentQuery.data;
  const isSystem = agentId === 'agt_system_helper_chat' || existing?.kind === 'system';
  const [name, setName] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const [nameError, setNameError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [execution, setExecution] = useState<AgentExecutionView | null>(null);
  const [executionMessage, setExecutionMessage] = useState('');
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setResponsibility(existing.responsibility);
    setSystemPrompt(existing.systemPrompt);
    setModel(existing.model);
    setProviderId(existing.providerId);
    setSelectedSkillIds(existing.skills.map((skill) => skill.id));
    setSelectedMcpServerIds(existing.mcpServers.map((server) => server.id));
    setNameError('');
    setSaveError('');
    setSaveState('saved');
  }, [existing]);

  useEffect(() => {
    const executionId = execution?.id;
    if (!executionId || execution.status !== 'running' || isSystem) return;
    const timer = window.setInterval(() => {
      void api.agentExecution(workspaceSlug, agentId, executionId).then(setExecution).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [agentId, execution?.id, execution?.status, isSystem, workspaceSlug]);

  function markUnsaved() {
    setSaveError('');
    setSaveState('unsaved');
  }

  function changeProvider(nextProviderId: string | null) {
    const provider = providersQuery.data?.find((item) => item.id === nextProviderId);
    setProviderId(nextProviderId);
    setModel(provider?.models.includes(model) ? model : provider?.models[0] ?? '');
    markUnsaved();
  }

  function toggleSelection(id: string, checked: boolean, selected: string[], setSelected: (next: string[]) => void) {
    setSelected(checked ? [...new Set([...selected, id])] : selected.filter((item) => item !== id));
    markUnsaved();
  }

  async function save() {
    if (!isSystem && !name.trim()) {
      setNameError(t('editor.nameRequired'));
      return;
    }
    setNameError('');
    setSaveError('');
    setSaveState('saving');
    try {
      const saved = isNew
        ? await api.createAgent(workspaceSlug, {
            name,
            responsibility,
            systemPrompt,
            providerId,
            model,
            skillIds: selectedSkillIds,
            mcpServerIds: selectedMcpServerIds,
          })
        : await api.updateAgent(
            workspaceSlug,
            agentId,
            isSystem
              ? { providerId, model }
              : {
                  name,
                  responsibility,
                  systemPrompt,
                  providerId,
                  model,
                  skillIds: selectedSkillIds,
                  mcpServerIds: selectedMcpServerIds,
                },
          );
      await queryClient.invalidateQueries({ queryKey: agentsQueryKey() });
      if (!isNew) await queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
      setSaveState('saved');
      if (isNew) void navigate({ to: '/agents/$agentId', params: { agentId: saved.id }, replace: true });
    } catch {
      setSaveState('unsaved');
      setSaveError(t('editor.saveFailed'));
    }
  }

  async function submitExecution(event: FormEvent) {
    event.preventDefault();
    const message = executionMessage.trim();
    if (!message || executionBusy || isNew || isSystem) return;
    setExecutionBusy(true);
    setExecutionError('');
    try {
      const next = execution
        ? await api.continueAgentExecution(workspaceSlug, agentId, execution.id, message)
        : await api.createAgentExecution(workspaceSlug, agentId, message);
      setExecution(next);
      setExecutionMessage('');
    } catch {
      setExecutionError(t('execution.requestFailed'));
    } finally {
      setExecutionBusy(false);
    }
  }

  async function cancelExecution() {
    if (!execution || execution.status !== 'running' || executionBusy) return;
    setExecutionBusy(true);
    setExecutionError('');
    try {
      setExecution(await api.cancelAgentExecution(workspaceSlug, agentId, execution.id));
    } catch {
      setExecutionError(t('execution.cancelFailed'));
    } finally {
      setExecutionBusy(false);
    }
  }

  const editorLoading = !isNew && agentQuery.isLoading;
  const editorFailed = !isNew && agentQuery.isError;
  const configurationProps = {
    isSystem,
    providerId,
    model,
    providers: providersQuery.data ?? [],
    providersLoading: providersQuery.isLoading,
    providersFailed: providersQuery.isError,
    skills: (skillsQuery.data ?? []).filter((skill) => isSystem || skill.id !== 'sk_worklite_platform'),
    skillsLoading: skillsQuery.isLoading,
    skillsFailed: skillsQuery.isError,
    selectedSkillIds,
    mcpServers: mcpServersQuery.data ?? [],
    mcpServersLoading: mcpServersQuery.isLoading,
    mcpServersFailed: mcpServersQuery.isError,
    selectedMcpServerIds,
    onProviderChange: changeProvider,
    onModelChange: (value: string) => {
      setModel(value);
      markUnsaved();
    },
    onSkillChange: (id: string, checked: boolean) => toggleSelection(id, checked, selectedSkillIds, setSelectedSkillIds),
    onMcpServerChange: (id: string, checked: boolean) => toggleSelection(id, checked, selectedMcpServerIds, setSelectedMcpServerIds),
  };

  return (
    <div className="flex h-full min-h-0">
      <WorkspaceChrome
        back={
          <Button variant="ghost" size="icon-compact" type="button" aria-label={t('common:actions.back')} onClick={() => void navigate({ to: '/agents' })}>
            <ArrowLeft className="size-4" />
          </Button>
        }
        crumbs={[
          { label: t('title'), to: '/agents' },
          { label: isNew ? t('editor.new') : existing?.name ?? t('editor.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <Button size="compact" type="button" onClick={() => void save()} disabled={saveState === 'saving' || editorLoading || editorFailed}>
            {t('common:actions.save')}
          </Button>
        }
      />
      <div className="min-w-0 flex-1 overflow-auto px-6 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {editorLoading ? <ResourceMessage loading>{t('loading')}</ResourceMessage> : null}
          {editorFailed ? <ResourceMessage error>{t('editor.loadFailed')}</ResourceMessage> : null}
          <Field label={t('editor.name')} htmlFor="name" error={nameError}>
            <Input id="name" value={name} readOnly={isSystem} disabled={editorLoading || editorFailed} onChange={(event) => { setName(event.target.value); setNameError(''); markUnsaved(); }} />
          </Field>
          <Field label={t('editor.responsibility')} htmlFor="responsibility">
            <Input id="responsibility" value={responsibility} readOnly={isSystem} disabled={editorLoading || editorFailed} onChange={(event) => { setResponsibility(event.target.value); markUnsaved(); }} />
          </Field>
          <Field label={t('editor.instructions')} htmlFor="instructions" hint={t('editor.instructionsHint')}>
            <Textarea
              id="instructions"
              className="min-h-64 font-mono text-[13px]"
              value={systemPrompt}
              readOnly={isSystem}
              disabled={editorLoading || editorFailed}
              onChange={(event) => { setSystemPrompt(event.target.value); markUnsaved(); }}
            />
          </Field>
          {saveError ? <ResourceMessage error>{saveError}</ResourceMessage> : null}
          {!isNew && !isSystem && existing ? (
            <AgentExecutionPanel
              configured={Boolean(existing.providerId && existing.model)}
              saved={saveState === 'saved'}
              execution={execution}
              message={executionMessage}
              busy={executionBusy}
              error={executionError}
              onMessageChange={setExecutionMessage}
              onSubmit={submitExecution}
              onCancel={() => void cancelExecution()}
              onReset={() => { setExecution(null); setExecutionError(''); }}
            />
          ) : null}
          <section className="border-t border-border pt-5 lg:hidden" aria-labelledby="agent-mobile-configuration-title">
            <h2 id="agent-mobile-configuration-title" className="text-sm font-semibold">{t('editor.configuration')}</h2>
            <div className="mt-4"><AgentConfigurationFields {...configurationProps} idPrefix="mobile" /></div>
          </section>
        </div>
      </div>
      <aside className="hidden w-[360px] shrink-0 overflow-auto border-l border-border bg-surface p-4 lg:block" aria-labelledby="agent-configuration-title">
        <h2 id="agent-configuration-title" className="text-sm font-semibold">{t('editor.configuration')}</h2>
        <div className="mt-4"><AgentConfigurationFields {...configurationProps} idPrefix="desktop" /></div>
      </aside>
    </div>
  );
}

function AgentExecutionPanel({
  configured,
  saved,
  execution,
  message,
  busy,
  error,
  onMessageChange,
  onSubmit,
  onCancel,
  onReset,
}: {
  configured: boolean;
  saved: boolean;
  execution: AgentExecutionView | null;
  message: string;
  busy: boolean;
  error: string;
  onMessageChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('agents');
  const running = execution?.status === 'running';
  const canSend = configured && saved && !busy && (!execution || execution.status === 'completed' || execution.status === 'cancelled') && Boolean(message.trim());
  const events = execution ? [
    ...execution.messages.map((item) => ({ kind: 'message' as const, occurredAt: item.createdAt, item })),
    ...execution.toolCalls.map((item) => ({ kind: 'tool' as const, occurredAt: item.createdAt, item })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)) : [];
  const status = execution?.status;

  return (
    <section className="border-t border-border pt-5" aria-labelledby="agent-execution-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="agent-execution-title" className="text-sm font-semibold">{t('execution.title')}</h2>
          {execution && status ? <StatusBadge className="mt-2" status={status} /> : null}
        </div>
        {execution ? (
          <Button type="button" variant="secondary" size="compact" onClick={onReset} disabled={busy || execution.status === 'running'}>
            <RotateCcw className="size-4" aria-hidden="true" />
            {t('execution.newSession')}
          </Button>
        ) : null}
      </div>

      {!configured ? <ResourceMessage error>{t('execution.configureModel')}</ResourceMessage> : null}
      {configured && !saved ? <ResourceMessage>{t('execution.saveFirst')}</ResourceMessage> : null}

      {events.length > 0 ? (
        <div className="mt-4 space-y-4" aria-live="polite">
          {events.map((event) => event.kind === 'message' ? (
            <div key={event.item.id} className={event.item.role === 'user' ? 'ml-auto max-w-[85%] rounded-lg bg-surface-subtle px-3 py-2 text-sm' : 'max-w-full'}>
              <span className="sr-only">{event.item.role === 'user' ? t('execution.userMessage') : t('execution.agentMessage')}</span>
              {event.item.role === 'assistant' ? <StreamingMarkdown content={event.item.content} /> : <p className="whitespace-pre-wrap break-words">{event.item.content}</p>}
            </div>
          ) : (
            <AgentToolCallPanel key={event.item.id} call={event.item} />
          ))}
          {running ? <AgentWorkingRow /> : null}
        </div>
      ) : null}

      {execution?.error ? <div className="mt-4"><ResourceMessage error>{execution.error}</ResourceMessage></div> : null}
      {error ? <div className="mt-4"><ResourceMessage error>{error}</ResourceMessage></div> : null}

      <form className="mt-4 flex items-end gap-2" onSubmit={onSubmit}>
        <Textarea
          className="min-h-20 flex-1"
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          placeholder={t('execution.placeholder')}
          aria-label={t('execution.messageLabel')}
          disabled={!configured || !saved}
        />
        <Button type={running ? 'button' : 'submit'} variant={running ? 'secondary' : 'primary'} size="compact" disabled={running ? busy : !canSend} onClick={running ? onCancel : undefined}>
          {running ? <Square className="size-3.5 fill-current" aria-hidden="true" /> : busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
          {running ? t('execution.stop') : t('execution.send')}
        </Button>
      </form>
    </section>
  );
}

function AgentWorkingRow() {
  const { t } = useTranslation('agents');
  return <div className="flex items-center gap-3 py-2 text-[13px] text-muted-foreground" role="status"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface"><LoaderCircle className="size-4 text-brand motion-safe:animate-spin" aria-hidden="true" /></span><span>{t('execution.working')}</span></div>;
}

function AgentToolCallPanel({ call }: { call: AgentToolCallView }) {
  const { t } = useTranslation('agents');
  const [expanded, setExpanded] = useState(false);
  const finished = call.status === 'completed' || call.status === 'failed' || call.status === 'cancelled';
  const variant = call.status === 'completed' ? 'success' : call.status === 'running' ? 'brand' : call.status === 'cancelled' ? 'neutral' : 'danger';
  const scriptName = call.scriptPath?.split('/').pop() || t('execution.tool.script');

  return (
    <div className="border-l-2 border-warning bg-surface-subtle">
      <button type="button" className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-background/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={expanded} aria-label={expanded ? t('execution.tool.collapse') : t('execution.tool.expand')} onClick={() => setExpanded((value) => !value)}>
        <FileCode2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{call.skillName || t('execution.tool.skillTitle')} <span className="font-mono text-xs font-normal text-muted-foreground">/ {scriptName}</span></span>
        {finished && call.exitCode !== null ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{t('execution.tool.exitCode', { code: call.exitCode })}</span> : null}
        <Badge variant={variant}>{t(`execution.tool.status.${call.status}`)}</Badge>
        {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </button>
      {expanded ? <div className="border-t border-border px-3 pb-3 pt-2.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><p className="text-xs font-medium text-muted-foreground">{t('execution.tool.skill')}</p><code className="mt-1 block break-all font-mono text-xs">{call.skillName}</code></div>
          <div><p className="text-xs font-medium text-muted-foreground">{t('execution.tool.script')}</p><code className="mt-1 block break-all font-mono text-xs">{call.scriptPath}</code></div>
          <div className="sm:col-span-2"><p className="text-xs font-medium text-muted-foreground">{t('execution.tool.arguments')}</p><pre className="mt-1 max-w-full overflow-x-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code>{JSON.stringify(call.arguments)}</code></pre></div>
        </div>
        <p className="mt-3 text-xs font-medium text-muted-foreground">{t('execution.tool.workingDirectory')}</p>
        <code className="mt-1 block overflow-x-auto whitespace-nowrap font-mono text-xs">{call.workingDirectory}</code>
        <p className="mt-3 flex items-start gap-2 text-[13px] text-warning"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t('execution.tool.warning')}</p>
        {finished ? <div className="mt-3"><p className="text-xs font-medium text-muted-foreground">{t('execution.tool.output', { code: call.exitCode ?? t('execution.tool.noExitCode') })}</p><pre className="mt-1 max-h-40 max-w-full overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-xs"><code>{call.output || t('execution.tool.noOutput')}</code></pre></div> : null}
      </div> : null}
    </div>
  );
}

type AgentConfigurationFieldsProps = {
  idPrefix: string;
  isSystem: boolean;
  providerId: string | null;
  model: string;
  providers: ModelProviderView[];
  providersLoading: boolean;
  providersFailed: boolean;
  skills: SkillView[];
  skillsLoading: boolean;
  skillsFailed: boolean;
  selectedSkillIds: string[];
  mcpServers: McpServerView[];
  mcpServersLoading: boolean;
  mcpServersFailed: boolean;
  selectedMcpServerIds: string[];
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (model: string) => void;
  onSkillChange: (skillId: string, checked: boolean) => void;
  onMcpServerChange: (serverId: string, checked: boolean) => void;
};

function AgentConfigurationFields({
  idPrefix,
  isSystem,
  providerId,
  model,
  providers,
  providersLoading,
  providersFailed,
  skills,
  skillsLoading,
  skillsFailed,
  selectedSkillIds,
  mcpServers,
  mcpServersLoading,
  mcpServersFailed,
  selectedMcpServerIds,
  onProviderChange,
  onModelChange,
  onSkillChange,
  onMcpServerChange,
}: AgentConfigurationFieldsProps) {
  const { t } = useTranslation(['agents', 'common']);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const models = selectedProvider?.models ?? [];
  const providerFieldId = `${idPrefix}-provider`;
  const modelFieldId = `${idPrefix}-model`;

  return (
    <div className="flex flex-col gap-5">
      <Field label={t('editor.provider')} htmlFor={providerFieldId} hint={isSystem ? t('editor.providerHint') : t('editor.providerHintCustom')}>
        <Select value={providerId ?? 'not-configured'} onValueChange={(value) => onProviderChange(value === 'not-configured' ? null : value)} disabled={providersLoading || providersFailed}>
          <SelectTrigger id={providerFieldId}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="not-configured">{t('notConfigured')}</SelectItem>
            {providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {providersLoading ? <ResourceMessage loading>{t('editor.resourcesLoading')}</ResourceMessage> : null}
      {providersFailed ? <ResourceMessage error>{t('loadFailed')}</ResourceMessage> : null}
      <Field label={t('editor.model')} htmlFor={modelFieldId} hint={providerId && models.length === 0 ? t('editor.noModels') : t('editor.modelHint')}>
        <Select value={model || 'not-configured'} onValueChange={(value) => onModelChange(value === 'not-configured' ? '' : value)} disabled={!providerId || providersLoading || providersFailed}>
          <SelectTrigger id={modelFieldId}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="not-configured">{t('notConfigured')}</SelectItem>
            {models.map((providerModel) => <SelectItem key={providerModel} value={providerModel}>{providerModel}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      {isSystem ? (
        <div className="border-y border-border py-3">
          <p className="text-[13px] text-muted-foreground">{t('editor.systemHint')}</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">{t('editor.builtInCapabilities')}</span>
            <span className="flex flex-wrap justify-end gap-2">
              {skillsLoading ? <LoaderCircle className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label={t('editor.resourcesLoading')} /> : null}
              {skillsFailed ? <span className="text-xs text-danger">{t('editor.skillsLoadFailed')}</span> : null}
              {!skillsLoading && !skillsFailed ? skills.filter((skill) => selectedSkillIds.includes(skill.id)).map((skill) => <Badge key={skill.id} variant="neutral">{skill.name}</Badge>) : null}
            </span>
          </div>
        </div>
      ) : (
        <>
          <AssignmentSection
            title={t('editor.skills')}
            hint={t('editor.skillsHint')}
            count={selectedSkillIds.length}
            loading={skillsLoading}
            failed={skillsFailed}
            loadFailedMessage={t('editor.skillsLoadFailed')}
            empty={skills.length === 0}
            emptyMessage={t('editor.noSkills')}
            emptyAction={<Button asChild type="button" variant="secondary" size="compact"><Link to="/skills/$skillId" params={{ skillId: 'new' }}>{t('editor.createSkill')}</Link></Button>}
          >
            {skills.map((skill) => (
              <label key={skill.id} className="flex min-h-10 items-start gap-2 py-1 text-[13px]">
                <Checkbox checked={selectedSkillIds.includes(skill.id)} onCheckedChange={(checked) => onSkillChange(skill.id, checked === true)} aria-label={skill.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{skill.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{skill.version}</span>
                  </span>
                </span>
              </label>
            ))}
          </AssignmentSection>
          <AssignmentSection
            title={t('editor.mcpServers')}
            hint={t('editor.mcpServersHint')}
            count={selectedMcpServerIds.length}
            loading={mcpServersLoading}
            failed={mcpServersFailed}
            loadFailedMessage={t('editor.mcpLoadFailed')}
            empty={mcpServers.length === 0}
            emptyMessage={t('editor.noMcpServers')}
            emptyAction={<Button asChild type="button" variant="secondary" size="compact"><Link to="/mcp-servers/$serverId" params={{ serverId: 'new' }}>{t('editor.connectMcpServer')}</Link></Button>}
          >
            {mcpServers.map((server) => (
              <label key={server.id} className="flex min-h-10 items-start gap-2 py-1 text-[13px]">
                <Checkbox checked={selectedMcpServerIds.includes(server.id)} onCheckedChange={(checked) => onMcpServerChange(server.id, checked === true)} aria-label={server.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{server.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{server.version} · {server.allowedTools}</span>
                    <StatusBadge status={server.connection} />
                  </span>
                </span>
              </label>
            ))}
          </AssignmentSection>
        </>
      )}
    </div>
  );
}

function AssignmentSection({
  title,
  hint,
  count,
  loading,
  failed,
  loadFailedMessage,
  empty,
  emptyMessage,
  emptyAction,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  loading: boolean;
  failed: boolean;
  loadFailedMessage: string;
  empty: boolean;
  emptyMessage: string;
  emptyAction: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('agents');

  return (
    <fieldset className="space-y-2 border-t border-border pt-4">
      <legend className="flex w-full items-center justify-between gap-3 text-xs font-medium">
        <span>{title}</span>
        <span className="font-normal text-muted-foreground">{t('editor.selectedCount', { count })}</span>
      </legend>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {loading ? <ResourceMessage loading>{t('editor.resourcesLoading')}</ResourceMessage> : null}
      {failed ? <ResourceMessage error>{loadFailedMessage}</ResourceMessage> : null}
      {!loading && !failed && empty ? (
        <div className="space-y-2 py-1">
          <p className="text-[13px] text-muted-foreground">{emptyMessage}</p>
          {emptyAction}
        </div>
      ) : null}
      {!loading && !failed && !empty ? <div className="divide-y divide-border">{children}</div> : null}
    </fieldset>
  );
}

function ResourceMessage({ loading, error, children }: { loading?: boolean; error?: boolean; children: ReactNode }) {
  return (
    <p className={`flex items-center gap-2 text-[13px] ${error ? 'text-danger' : 'text-muted-foreground'}`} role={error ? 'alert' : loading ? 'status' : undefined}>
      {loading ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
      {error ? <AlertCircle className="size-4" aria-hidden="true" /> : null}
      {children}
    </p>
  );
}
