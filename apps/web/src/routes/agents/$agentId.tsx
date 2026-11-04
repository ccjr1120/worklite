import { AgentOverview } from '@/features/agents/agent-overview';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentView, CreateAgentRequest, AgentCollaboration, AgentRuntimeConfiguration } from '@worklite/contracts';
import { api } from '@/api/client';
import { useAgentsQuery, useSkillsQuery, useMcpServersQuery } from '@/api/queries';
import { queryClient } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { PageHeading } from '@/components/page-heading';
import { ErrorState } from '@/components/error-state';

export const Route = createFileRoute('/agents/$agentId')({ validateSearch: (search: Record<string, unknown>): { parentId?: string; runId?: string } => ({ runId: typeof search.runId === 'string' ? search.runId : undefined, parentId: typeof search.parentId === 'string' ? search.parentId : undefined }), component: AgentPage });
function AgentPage() {
  const { agentId } = Route.useParams();
  const { t } = useTranslation('agents');
  const { runId } = Route.useSearch();
  const isNew = agentId === 'new';
  const [editing, setEditing] = useState(false);
  const query = useQuery({ queryKey: ['agent', agentId], queryFn: () => api.agent('personal', agentId), enabled: !isNew });
  if (!isNew && query.isError) return <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void query.refetch()} />;
  if (!isNew && !query.data) return <p className="p-6 text-sm">{t('loading')}</p>;
  if (!isNew && query.data && !editing) return <AgentOverview key={agentId} agent={query.data} initialRunId={runId} onConfigure={() => setEditing(true)} />;
  return <><AgentEditor key={agentId} agent={query.data} onSaved={() => setEditing(false)} onBack={!isNew ? () => setEditing(false) : undefined} /></>;
}
function AgentEditor({ agent, onSaved, onBack }: { agent?: AgentView; onSaved: () => void; onBack?: () => void }) {
  const { t } = useTranslation('agents');
  const navigate = Route.useNavigate();
  const { parentId } = Route.useSearch();
  const directory = useAgentsQuery();
  const skills = useSkillsQuery('personal');
  const servers = useMcpServersQuery('personal');
  const [name, setName] = useState(agent?.name ?? '');
  const [responsibility, setResponsibility] = useState(agent?.responsibility ?? '');
  const [prompt, setPrompt] = useState(agent?.systemPrompt ?? '');
  const [runtimeKind, setRuntimeKind] = useState<'native' | 'codex' | 'claude'>(agent?.runtime?.kind ?? 'native');
  const [projectDirectory, setProjectDirectory] = useState(agent?.runtime && agent.runtime.kind !== 'native' ? agent.runtime.projectDirectory : '');
  const [models, setModels] = useState((agent?.collaboration?.publicModels ?? []).join('\n'));
  const [subAgentIds, setSubAgentIds] = useState(agent?.collaboration?.subAgentIds ?? []);
  const [builtinToolNames, setBuiltinToolNames] = useState(agent?.collaboration?.builtinToolNames ?? []);
  const [skillIds, setSkillIds] = useState(agent?.skills.map((skill) => skill.id) ?? []);
  const [mcpServerIds, setMcpServerIds] = useState(agent?.mcpServers.map((server) => server.id) ?? []);
  const [privateTools, setPrivateTools] = useState(JSON.stringify(agent?.collaboration?.privateTools ?? [], null, 2));
  const [capabilities, setCapabilities] = useState(JSON.stringify(agent?.collaboration?.capabilities ?? [], null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function toggle(id: string, values: string[], change: (values: string[]) => void) { change(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const publicModels = models.split('\n').map((model) => model.trim()).filter(Boolean);
      const collaboration: AgentCollaboration = { ...agent?.collaboration, builtinToolNames, subAgentIds, privateTools: JSON.parse(privateTools) as AgentCollaboration['privateTools'], capabilities: JSON.parse(capabilities) as AgentCollaboration['capabilities'], publicModels };
      const runtime: AgentRuntimeConfiguration = runtimeKind === 'native' ? { kind: 'native' } : { ...(agent?.runtime && agent.runtime.kind !== 'native' ? agent.runtime : {}), kind: runtimeKind, projectDirectory };
      const input: CreateAgentRequest = { parentAgentId: !agent ? parentId : undefined, runtime, name, responsibility, systemPrompt: prompt, providerId: agent?.providerId ?? null, model: agent?.providerId ? agent.model : publicModels[0] ?? '', skillIds, mcpServerIds, collaboration };
      const saved = agent ? await api.updateAgent('personal', agent.id, input) : await api.createAgent(input);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['agents'] }), queryClient.invalidateQueries({ queryKey: ['agent', saved.id] })]);
      onSaved();
      void navigate({ to: '/agents/$agentId', params: { agentId: saved.id } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('saveFailed')); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!agent) return; setBusy(true); setError('');
    try { await api.deleteAgent(agent.id); await queryClient.invalidateQueries({ queryKey: ['agents'] }); void navigate({ to: '/agents' }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('deleteFailed')); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
    <WorkspaceChrome crumbs={[{ label: t('title'), to: '/agents' }, { label: agent?.name ?? t('create') }]} />
    <PageHeading title={agent?.name ?? t('create')} actions={onBack ? <Button variant="secondary" onClick={onBack}>{t('backToRuns')}</Button> : undefined} />
    <form onSubmit={(event) => void save(event)} className="mt-6 space-y-5">
      <Field label={t('name')} htmlFor="agent-name"><Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field>
      <Field label={t('responsibility')} htmlFor="agent-responsibility"><Textarea id="agent-responsibility" value={responsibility} onChange={(event) => setResponsibility(event.target.value)} /></Field>
      <Field label={t('prompt')} htmlFor="agent-prompt"><Textarea id="agent-prompt" className="min-h-64" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></Field>
      <Field label={t('runtime')} htmlFor="agent-runtime"><select id="agent-runtime" className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm" value={runtimeKind} onChange={(event) => setRuntimeKind(event.target.value as 'native' | 'codex' | 'claude')}><option value="native">{t('native')}</option><option value="codex" disabled={subAgentIds.length > 0 || capabilities.trim() !== '[]' || privateTools.trim() !== '[]'}>Codex</option><option value="claude" disabled={subAgentIds.length > 0 || capabilities.trim() !== '[]' || privateTools.trim() !== '[]'}>Claude Code</option></select></Field>
      {runtimeKind !== 'native' ? <Field label={t('projectDirectory')} htmlFor="agent-directory"><Input id="agent-directory" value={projectDirectory} onChange={(event) => setProjectDirectory(event.target.value)} placeholder={t('directoryPlaceholder')} /></Field> : null}
      <Field label={t('models')} htmlFor="agent-models"><Textarea id="agent-models" value={models} onChange={(event) => setModels(event.target.value)} placeholder="provider/model" /></Field>
      {runtimeKind === 'native' ? <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('subAgents')}</legend>{(directory.data ?? []).filter((item) => item.kind === 'custom' && item.id !== agent?.id).map((item) => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subAgentIds.includes(item.id)} onChange={() => toggle(item.id, subAgentIds, setSubAgentIds)} />{item.name}</label>)}{agent ? <Button asChild variant="secondary" size="compact"><Link to="/agents/$agentId" params={{ agentId: 'new' }} search={{ parentId: agent.id }}>{t('createSubAgent')}</Link></Button> : null}</fieldset> : null}
      {runtimeKind === 'native' ? <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('builtinTools')}</legend>{(['bash', 'read', 'write', 'glob', 'grep'] as const).map((tool) => <label key={tool} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={builtinToolNames.includes(tool)} onChange={() => toggle(tool, builtinToolNames, setBuiltinToolNames)} />{t(`tools.${tool}`)}</label>)}</fieldset> : null}
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('skills')}</legend>{(skills.data ?? []).map((item) => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={skillIds.includes(item.id)} onChange={() => toggle(item.id, skillIds, setSkillIds)} />{item.name}</label>)}</fieldset>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('mcpServers')}</legend>{(servers.data ?? []).map((item) => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mcpServerIds.includes(item.id)} onChange={() => toggle(item.id, mcpServerIds, setMcpServerIds)} />{item.name}</label>)}</fieldset>
      {runtimeKind === 'native' ? <Field label={t('capabilities')} htmlFor="agent-capabilities"><Textarea id="agent-capabilities" className="min-h-40 font-mono text-xs" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></Field> : null}
      {runtimeKind === 'native' ? <Field label={t('privateTools')} htmlFor="agent-private-tools"><Textarea id="agent-private-tools" className="min-h-40 font-mono text-xs" value={privateTools} onChange={(event) => setPrivateTools(event.target.value)} /></Field> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <div className="flex items-center gap-2"><Button type="submit" disabled={busy}>{t('save')}</Button>{agent ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void remove()}>{t('delete')}</Button> : null}</div>
    </form>
  </div>;
}
