import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { useNavigate } from '@tanstack/react-router';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentTeamDeveloperInstanceConfiguration,
  AgentTeamRole,
  AgentTeamRoleConfiguration,
  AgentTeamView,
  ProjectExecutor,
} from '@worklite/contracts';
import { ApiError, api } from '@/api/client';
import {
  agentTeamQueryKey,
  useAgentTeamQuery,
  useMcpServersQuery,
  useModelProvidersQuery,
  useSkillsQuery,
} from '@/api/queries';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { SaveIndicator } from '@/components/save-indicator';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { TeamConversation } from './team-conversation';
import { queryClient } from '@/lib/query-client';

const TEAM_MODEL_SENTINEL = '__team_default__';
const ROLE_ORDER: AgentTeamRole[] = ['planner', 'test_designer', 'developer', 'test_author', 'test_runner', 'reviewer'];
const ROLE_TOOLS: Record<AgentTeamRole, string[]> = {
  planner: ['read', 'glob', 'grep', 'process_reference'],
  test_designer: ['read', 'glob', 'grep', 'process_reference'],
  developer: ['bash', 'read', 'write', 'glob', 'grep', 'process_reference'],
  test_author: ['read', 'write', 'glob', 'grep', 'process_reference'],
  test_runner: ['bash', 'read', 'write', 'glob', 'grep'],
  reviewer: ['read', 'glob', 'grep', 'process_reference'],
};
const MAX_DEVELOPER_INSTANCES = 3;
const MAX_DEVELOPER_CONCURRENCY = 4;
const EXECUTORS: ProjectExecutor[] = ['claude', 'codex'];

type EditableRoleFields = Pick<AgentTeamRoleConfiguration, 'instructions' | 'entryPoints' | 'skillIds' | 'mcpServerIds' | 'toolNames'>;

function toDraftRoles(roles: readonly AgentTeamRoleConfiguration[]): AgentTeamRoleConfiguration[] {
  const byRole = new Map(roles.map((role) => [role.role, role]));
  return ROLE_ORDER.map((role) => {
    const source = byRole.get(role);
    return {
      role,
      publicModelId: source?.publicModelId || TEAM_MODEL_SENTINEL,
      instructions: source?.instructions ?? '',
      entryPoints: source?.entryPoints ?? [],
      skillIds: source?.skillIds ?? [],
      mcpServerIds: source?.mcpServerIds ?? [],
      toolNames: source?.toolNames ?? [],
      ...(source?.executor ? { executor: source.executor } : {}),
      ...(source?.developerInstances
        ? {
            developerInstances: source.developerInstances.map((instance) => ({
              ...instance,
              publicModelId: instance.publicModelId || TEAM_MODEL_SENTINEL,
            })),
          }
        : {}),
      ...(source?.developerConcurrency !== undefined ? { developerConcurrency: source.developerConcurrency } : {}),
    };
  });
}

function toPersistedRoles(roles: readonly AgentTeamRoleConfiguration[]): AgentTeamRoleConfiguration[] {
  return ROLE_ORDER.map((role) => {
    const source = roles.find((item) => item.role === role);
    if (!source) throw new Error(`The ${role} role configuration is missing.`);
    const base: AgentTeamRoleConfiguration = {
      role,
      publicModelId: source.publicModelId === TEAM_MODEL_SENTINEL ? '' : source.publicModelId,
      instructions: source.instructions,
      entryPoints: source.entryPoints.filter(Boolean),
      skillIds: source.skillIds,
      mcpServerIds: source.mcpServerIds,
      toolNames: source.toolNames,
      ...(source.executor ? { executor: source.executor } : {}),
    };
    if (role !== 'developer') return base;
    return {
      ...base,
      ...(source.developerInstances
        ? {
            developerInstances: source.developerInstances.map((instance) => ({
              ...instance,
              publicModelId: instance.publicModelId === TEAM_MODEL_SENTINEL ? '' : instance.publicModelId,
              entryPoints: instance.entryPoints.filter(Boolean),
            })),
          }
        : {}),
      ...(source.developerConcurrency !== undefined ? { developerConcurrency: source.developerConcurrency } : {}),
    };
  });
}

function nextDeveloperId(instances: readonly AgentTeamDeveloperInstanceConfiguration[]): string {
  const used = new Set(instances.map((instance) => instance.developerId));
  for (let index = 2; ; index += 1) {
    const candidate = `developer_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function ExecutorSelect({ id, value, onChange }: { id: string; value: ProjectExecutor; onChange: (value: ProjectExecutor) => void }) {
  const { t } = useTranslation('agentTeams');
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ProjectExecutor)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EXECUTORS.map((executor) => (
          <SelectItem key={executor} value={executor}>{t(`team.executor.${executor}`)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelSelect({ id, value, modelGroups, onChange }: {
  id: string;
  value: string;
  modelGroups: Array<{ name: string; models: string[] }>;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('agentTeams');
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TEAM_MODEL_SENTINEL}>{t('model.default')}</SelectItem>
        {modelGroups.map((group) => (
          <SelectPrimitive.Group key={group.name}>
            <SelectPrimitive.Label className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {group.name}
            </SelectPrimitive.Label>
            {group.models.map((model) => (
              <SelectItem key={model} value={model}>{model}</SelectItem>
            ))}
          </SelectPrimitive.Group>
        ))}
      </SelectContent>
    </Select>
  );
}

function AdvancedRoleFields({ idPrefix, tools, value, onChange }: {
  idPrefix: string;
  tools: string[];
  value: EditableRoleFields;
  onChange: (changes: Partial<EditableRoleFields>) => void;
}) {
  const { t } = useTranslation('agentTeams');
  const skillsQuery = useSkillsQuery('personal');
  const mcpServersQuery = useMcpServersQuery('personal');

  function toggleSelection(selected: string[], item: string, checked: boolean) {
    return checked ? [...selected, item] : selected.filter((existing) => existing !== item);
  }

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <Field label={t('entryPoints.label')} htmlFor={`${idPrefix}-entry-points`}>
        <Textarea
          id={`${idPrefix}-entry-points`}
          className="min-h-20"
          value={value.entryPoints.join('\n')}
          placeholder={t('entryPoints.placeholder')}
          onChange={(event) => onChange({
            entryPoints: event.target.value.split(/\r?\n/).map((line) => line.trim()),
          })}
        />
      </Field>
      <Field label={t('instructions.label')} htmlFor={`${idPrefix}-instructions`}>
        <Textarea
          id={`${idPrefix}-instructions`}
          className="min-h-32"
          value={value.instructions}
          onChange={(event) => onChange({ instructions: event.target.value })}
        />
      </Field>
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-xs font-medium text-foreground">{t('skills.label')}</legend>
        {skillsQuery.isLoading ? <Skeleton className="h-20 w-full" /> : (skillsQuery.data ?? []).length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('skills.empty')}</p>
        ) : (skillsQuery.data ?? []).map((skill) => (
          <label key={skill.id} htmlFor={`${idPrefix}-skill-${skill.id}`} className="flex min-w-0 items-start gap-2 text-[13px]">
            <Checkbox
              id={`${idPrefix}-skill-${skill.id}`}
              className="mt-0.5"
              checked={value.skillIds.includes(skill.id)}
              onCheckedChange={(checked) => onChange({
                skillIds: toggleSelection(value.skillIds, skill.id, checked === true),
              })}
            />
            <span className="min-w-0">
              <span className="block font-medium">{skill.name}</span>
              <span className="block font-mono text-xs break-all text-muted-foreground">{skill.id}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-xs font-medium text-foreground">{t('mcpServers.label')}</legend>
        {mcpServersQuery.isLoading ? <Skeleton className="h-20 w-full" /> : (mcpServersQuery.data ?? []).length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('mcpServers.empty')}</p>
        ) : (mcpServersQuery.data ?? []).map((server) => (
          <label key={server.id} htmlFor={`${idPrefix}-mcp-${server.id}`} className="flex min-w-0 items-start gap-2 text-[13px]">
            <Checkbox
              id={`${idPrefix}-mcp-${server.id}`}
              className="mt-0.5"
              checked={value.mcpServerIds.includes(server.id)}
              onCheckedChange={(checked) => onChange({
                mcpServerIds: toggleSelection(value.mcpServerIds, server.id, checked === true),
              })}
            />
            <span className="min-w-0">
              <span className="block font-medium">{server.name}</span>
              <span className="block font-mono text-xs break-all text-muted-foreground">{server.id}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="min-w-0 xl:col-span-2">
        <legend className="text-xs font-medium text-foreground">{t('tools.label')}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {tools.map((tool) => (
            <label key={tool} className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={value.toolNames.includes(tool)}
                onCheckedChange={(checked) => onChange({
                  toolNames: toggleSelection(value.toolNames, tool, checked === true),
                })}
              />
              <span className="font-mono break-all">{tool}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function TeamDetailPage({ teamId, tab }: { teamId: string; tab: 'conversation' | 'configuration' }) {
  const { t } = useTranslation('agentTeams');
  const navigate = useNavigate();
  const workspaceSlug = 'personal';
  const teamQuery = useAgentTeamQuery(workspaceSlug, teamId);
  const providersQuery = useModelProvidersQuery(workspaceSlug);
  const skillsQuery = useSkillsQuery(workspaceSlug);
  const mcpServersQuery = useMcpServersQuery(workspaceSlug);
  const [draftTeamId, setDraftTeamId] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<AgentTeamRoleConfiguration[]>([]);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [saveNotice, setSaveNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const draftRevisionRef = useRef(0);

  useEffect(() => {
    if (!teamQuery.data || draftTeamId === teamQuery.data.id) return;
    setDraftTeamId(teamQuery.data.id);
    setRoleDrafts(toDraftRoles(teamQuery.data.roles));
    setSaveState('saved');
    setSaveNotice('');
    setSaveError('');
  }, [draftTeamId, teamQuery.data]);

  const modelGroups = useMemo(
    () => (providersQuery.data ?? [])
      .map((provider) => ({
        name: provider.name,
        models: provider.models.map((model) => `${provider.name}/${model}`),
      }))
      .filter((group) => group.models.length > 0),
    [providersQuery.data],
  );

  function markUnsaved() {
    setSaveState('unsaved');
    setSaveNotice('');
    setSaveError('');
  }

  function updateRole(role: AgentTeamRole, changes: Partial<AgentTeamRoleConfiguration>) {
    draftRevisionRef.current += 1;
    setRoleDrafts((current) => current.map((item) => (item.role === role ? { ...item, ...changes } : item)));
    markUnsaved();
  }

  function updateInstance(role: AgentTeamRole, developerId: string, changes: Partial<AgentTeamDeveloperInstanceConfiguration>) {
    const source = roleDrafts.find((item) => item.role === role);
    updateRole(role, {
      developerInstances: (source?.developerInstances ?? []).map((instance) => (
        instance.developerId === developerId ? { ...instance, ...changes } : instance
      )),
    });
  }

  function addInstance(role: AgentTeamRoleConfiguration) {
    const instances = role.developerInstances ?? [];
    if (instances.length >= MAX_DEVELOPER_INSTANCES) return;
    const developerId = nextDeveloperId(instances);
    const suffix = developerId.replace(/^developer_/, '');
    updateRole(role.role, {
      developerInstances: [
        ...instances,
        {
          developerId,
          label: `Developer ${suffix}`,
          publicModelId: TEAM_MODEL_SENTINEL,
          instructions: role.instructions,
          entryPoints: [],
          skillIds: [],
          mcpServerIds: [],
          toolNames: [],
          executor: 'claude',
        },
      ],
      developerConcurrency: role.developerConcurrency ?? Math.min(instances.length + 2, 2),
    });
  }

  function removeInstance(role: AgentTeamRoleConfiguration, developerId: string) {
    updateRole(role.role, {
      developerInstances: (role.developerInstances ?? []).filter((instance) => instance.developerId !== developerId),
    });
  }

  async function saveTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveState('saving');
    setSaveNotice('');
    setSaveError('');
    const draftRevision = draftRevisionRef.current;
    try {
      const saved: AgentTeamView = await api.updateAgentTeam(teamId, { roles: toPersistedRoles(roleDrafts) });
      const draftsChangedDuringSave = draftRevisionRef.current !== draftRevision;
      setRoleDrafts((current) => (draftsChangedDuringSave ? current : toDraftRoles(saved.roles)));
      setSaveState(draftsChangedDuringSave ? 'unsaved' : 'saved');
      setSaveNotice(draftsChangedDuringSave ? '' : t('team.updated'));
      queryClient.setQueryData(agentTeamQueryKey(teamId), saved);
    } catch (error: unknown) {
      setSaveState('unsaved');
      setSaveError(error instanceof Error ? error.message : t('team.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (teamQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('title') }]} />
        <div className="space-y-4" role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-8 w-72" />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Skeleton className="h-80 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
          {ROLE_ORDER.map((role) => <Skeleton key={role} className="h-72 w-full" />)}
        </div>
      </div>
    );
  }

  const notFound = teamQuery.isError && teamQuery.error instanceof ApiError && teamQuery.error.status === 404;
  if (notFound || (!teamQuery.isError && !teamQuery.data)) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('title') }]} />
        <EmptyState title={t('unavailable.title')} description={t('unavailable.description')} />
      </div>
    );
  }

  if (teamQuery.isError || !teamQuery.data) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={[{ label: t('title') }]} />
        <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void teamQuery.refetch()} />
      </div>
    );
  }

  const team = teamQuery.data;
  const resourceErrors = [
    providersQuery.isError ? { label: t('resources.providers'), refetch: providersQuery.refetch } : null,
    skillsQuery.isError ? { label: t('resources.skills'), refetch: skillsQuery.refetch } : null,
    mcpServersQuery.isError ? { label: t('resources.mcpServers'), refetch: mcpServersQuery.refetch } : null,
  ].filter(Boolean) as Array<{ label: string; refetch: () => Promise<unknown> }>;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }, { label: team.name }]}
        status={tab === 'configuration' ? <SaveIndicator state={saveState} /> : undefined}
        actions={tab === 'configuration' ? (
          <div className="flex flex-col items-end gap-1">
            <Button type="submit" form="agent-team-configuration" size="compact" disabled={saving}>
              {saving ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {saving ? t('team.saving') : t('team.save')}
            </Button>
            {saveError ? <p className="text-[13px] text-danger" role="alert">{saveError}</p> : null}
          </div>
        ) : undefined}
      />
      <PageHeading title={team.name} description={team.description} />
      <Tabs
        className="mt-6"
        value={tab}
        onValueChange={(value) => {
          if (value !== 'conversation' && value !== 'configuration') return;
          void navigate({
            to: '/agent-teams/$teamId',
            params: { teamId },
            search: { tab: value },
          });
        }}
      >
        <TabsList aria-label={t('title')}>
          <TabsTrigger value="conversation">{t('conversation.tab')}</TabsTrigger>
          <TabsTrigger value="configuration">{t('configuration.tab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="min-h-[560px]">
          <TeamConversation teamId={teamId} />
        </TabsContent>
        <TabsContent value="configuration">
          {resourceErrors.length > 0 ? (
            <div className="space-y-3">
              {resourceErrors.map((resource) => (
                <ErrorState
                  key={resource.label}
                  title={resource.label}
                  description={t('resources.loadFailed')}
                  onAction={() => void resource.refetch()}
                />
              ))}
            </div>
          ) : null}
          <section className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-process">
            <h2 id="agent-team-process" className="text-sm font-semibold">{t('team.process')}</h2>
            <dl className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t('team.processId')}</dt>
                <dd className="mt-1 font-mono break-all">{team.processId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('team.processVersion')}</dt>
                <dd className="mt-1 font-mono break-all">{team.processVersion}</dd>
              </div>
            </dl>
        </section>
        <form id="agent-team-configuration" className="mt-4 space-y-4" onSubmit={saveTeam}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('team.roles')}</h2>
          {saveNotice ? <p role="status">{saveNotice}</p> : null}
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {roleDrafts.map((role) => (
            <section key={role.role} className="min-w-0 p-4" aria-labelledby={`agent-team-role-${role.role}`}>
              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1fr)] sm:items-center">
                <h3 id={`agent-team-role-${role.role}`} className="text-sm font-semibold">{t(`role.${role.role}`)}</h3>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <Field label={t('model.label')} htmlFor={`agent-team-model-${role.role}`}>
                    <ModelSelect
                      id={`agent-team-model-${role.role}`}
                      value={role.publicModelId}
                      modelGroups={modelGroups}
                      onChange={(value) => updateRole(role.role, { publicModelId: value })}
                    />
                  </Field>
                  {role.role === 'developer' ? (
                    <Field label={t('team.executor.label')} htmlFor={`agent-team-executor-${role.role}`}>
                      <ExecutorSelect
                        id={`agent-team-executor-${role.role}`}
                        value={role.executor ?? 'claude'}
                        onChange={(value) => updateRole(role.role, { executor: value })}
                      />
                    </Field>
                  ) : null}
                </div>
              </div>
              {role.role === 'developer' ? (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-xs font-medium text-foreground">{t('team.instances.label')}</h4>
                    <Button
                      type="button"
                      variant="secondary"
                      size="compact"
                      disabled={(role.developerInstances ?? []).length >= MAX_DEVELOPER_INSTANCES}
                      onClick={() => addInstance(role)}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      {t('team.instances.add')}
                    </Button>
                  </div>
                  {(role.developerInstances ?? []).map((instance) => (
                    <div key={instance.developerId} className="min-w-0 space-y-3 rounded-lg border border-border bg-surface-subtle/40 p-3">
                      <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                        <Field label={t('team.instances.name')} htmlFor={`agent-team-instance-label-${instance.developerId}`}>
                          <Input
                            id={`agent-team-instance-label-${instance.developerId}`}
                            value={instance.label}
                            onChange={(event) => updateInstance(role.role, instance.developerId, { label: event.target.value })}
                          />
                        </Field>
                        <Field label={t('team.executor.label')} htmlFor={`agent-team-instance-executor-${instance.developerId}`}>
                          <ExecutorSelect
                            id={`agent-team-instance-executor-${instance.developerId}`}
                            value={instance.executor ?? 'claude'}
                            onChange={(value) => updateInstance(role.role, instance.developerId, { executor: value })}
                          />
                        </Field>
                        <Field label={t('model.label')} htmlFor={`agent-team-instance-model-${instance.developerId}`}>
                          <ModelSelect
                            id={`agent-team-instance-model-${instance.developerId}`}
                            value={instance.publicModelId}
                            modelGroups={modelGroups}
                            onChange={(value) => updateInstance(role.role, instance.developerId, { publicModelId: value })}
                          />
                        </Field>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-compact"
                          aria-label={t('team.instances.remove')}
                          onClick={() => removeInstance(role, instance.developerId)}
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                      <details className="border-t border-border pt-3">
                        <summary className="w-fit cursor-pointer rounded-sm text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45">
                          {t('team.advanced')}
                        </summary>
                        <AdvancedRoleFields
                          idPrefix={`agent-team-instance-${instance.developerId}`}
                          tools={ROLE_TOOLS.developer}
                          value={instance}
                          onChange={(changes) => updateInstance(role.role, instance.developerId, changes)}
                        />
                      </details>
                    </div>
                  ))}
                  {(role.developerInstances ?? []).length > 0 ? (
                    <Field label={t('team.concurrency.label')} htmlFor="agent-team-developer-concurrency">
                      <Select
                        value={String(role.developerConcurrency ?? 2)}
                        onValueChange={(value) => updateRole(role.role, { developerConcurrency: Number(value) })}
                      >
                        <SelectTrigger id="agent-team-developer-concurrency">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: MAX_DEVELOPER_CONCURRENCY }, (_, index) => index + 1).map((count) => (
                            <SelectItem key={count} value={String(count)}>{count}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                </div>
              ) : null}
              <details className="mt-3 border-t border-border pt-3">
                <summary className="w-fit cursor-pointer rounded-sm text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/45">
                  {t('team.advanced')}
                </summary>
                <AdvancedRoleFields
                  idPrefix={`agent-team-${role.role}`}
                  tools={ROLE_TOOLS[role.role]}
                  value={role}
                  onChange={(changes) => updateRole(role.role, changes)}
                />
              </details>
            </section>
          ))}
        </div>
        </form>
      </TabsContent>
      </Tabs>
    </div>
  );
}
