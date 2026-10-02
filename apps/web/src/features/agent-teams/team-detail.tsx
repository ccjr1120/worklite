import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentTeamRole, AgentTeamRoleConfiguration, AgentTeamView } from '@worklite/contracts';
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
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
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
const MODES = ['plan_only', 'validate_existing', 'implement_and_validate'] as const;

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
    };
  });
}

function toPersistedRoles(roles: readonly AgentTeamRoleConfiguration[]): AgentTeamRoleConfiguration[] {
  return ROLE_ORDER.map((role) => {
    const source = roles.find((item) => item.role === role);
    if (!source) throw new Error(`The ${role} role configuration is missing.`);
    return {
      role,
      publicModelId: source.publicModelId === TEAM_MODEL_SENTINEL ? '' : source.publicModelId,
      instructions: source.instructions,
      entryPoints: source.entryPoints.filter(Boolean),
      skillIds: source.skillIds,
      mcpServerIds: source.mcpServerIds,
      toolNames: source.toolNames,
    };
  });
}

function commandLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function TeamDetailPage({ teamId }: { teamId: string }) {
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
  const [intent, setIntent] = useState('');
  const [projectDirectory, setProjectDirectory] = useState('');
  const [mode, setMode] = useState<'plan_only' | 'validate_existing' | 'implement_and_validate'>('plan_only');
  const [commands, setCommands] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');

  useEffect(() => {
    if (!teamQuery.data || draftTeamId === teamQuery.data.id) return;
    setDraftTeamId(teamQuery.data.id);
    setRoleDrafts(toDraftRoles(teamQuery.data.roles));
    setSaveState('saved');
    setSaveNotice('');
    setSaveError('');
  }, [draftTeamId, teamQuery.data]);

  const modelOptions = useMemo(
    () => (providersQuery.data ?? []).flatMap((provider) => provider.models.map((model) => `${provider.name}/${model}`)),
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

  function toggleSelection(selected: string[], value: string, checked: boolean) {
    return checked ? [...selected, value] : selected.filter((item) => item !== value);
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

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) return;
    setStarting(true);
    setStartError('');
    try {
      const started = await api.createAgentTeamRun(teamId, {
        intent,
        projectDirectory,
        mode,
        authorizedCommands: mode === 'plan_only' ? [] : commandLines(commands),
      });
      await navigate({ to: '/agent-team-runs/$runId', params: { runId: started.run.id } });
    } catch (error: unknown) {
      setStartError(error instanceof Error ? error.message : t('run.startFailed'));
    } finally {
      setStarting(false);
    }
  }

  if (teamQuery.isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
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
      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
        <WorkspaceChrome crumbs={[{ label: t('title') }]} />
        <EmptyState title={t('unavailable.title')} description={t('unavailable.description')} />
      </div>
    );
  }

  if (teamQuery.isError || !teamQuery.data) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
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
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <WorkspaceChrome
        crumbs={[{ label: t('title') }, { label: team.name }]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <div className="flex flex-col items-end gap-1">
            <Button type="submit" form="agent-team-configuration" size="compact" disabled={saving}>
              {saving ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {saving ? t('team.saving') : t('team.save')}
            </Button>
            {saveError ? <p className="text-[13px] text-danger" role="alert">{saveError}</p> : null}
          </div>
        }
      />
      <PageHeading title={team.name} description={team.description} />
      {resourceErrors.length > 0 ? (
        <div className="mt-4 space-y-3">
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
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <form className="min-w-0 space-y-4 rounded-lg border border-border bg-surface p-4" onSubmit={startRun}>
          <h2 className="text-sm font-semibold">{t('run.title')}</h2>
          <Field label={t('run.intent')} htmlFor="agent-team-intent">
            <Textarea
              id="agent-team-intent"
              value={intent}
              placeholder={t('run.intentPlaceholder')}
              onChange={(event) => setIntent(event.target.value)}
            />
          </Field>
          <Field label={t('run.projectDirectory')} htmlFor="agent-team-directory">
            <Input
              id="agent-team-directory"
              value={projectDirectory}
              placeholder={t('run.projectDirectoryPlaceholder')}
              onChange={(event) => setProjectDirectory(event.target.value)}
            />
          </Field>
          <Field label={t('run.mode')} htmlFor="agent-team-mode">
            <Select value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
              <SelectTrigger id="agent-team-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`run.modeValue.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('run.commands')} htmlFor="agent-team-commands" hint={t('run.commandsHint')}>
            <Textarea
              id="agent-team-commands"
              className="min-h-20"
              value={commands}
              placeholder={t('run.commandsPlaceholder')}
              onChange={(event) => setCommands(event.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <Button type="submit" disabled={starting}>
              {starting ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {starting ? t('run.starting') : t('run.start')}
            </Button>
            {startError ? <p className="text-[13px] text-danger" role="alert">{startError}</p> : null}
          </div>
        </form>
        <aside className="min-w-0 rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold">{t('team.process')}</h2>
          <dl className="mt-3 space-y-3 text-[13px]">
            <div>
              <dt className="text-muted-foreground">{t('team.processId')}</dt>
              <dd className="mt-1 font-mono break-all">{team.processId}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('team.processVersion')}</dt>
              <dd className="mt-1 font-mono break-all">{team.processVersion}</dd>
            </div>
          </dl>
        </aside>
      </div>
      <form id="agent-team-configuration" className="mt-6 space-y-4" onSubmit={saveTeam}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('team.roles')}</h2>
          {saveNotice ? <p role="status">{saveNotice}</p> : null}
        </div>
        {roleDrafts.map((role) => (
          <article key={role.role} className="min-w-0 rounded-lg border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">{t(`role.${role.role}`)}</h3>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <Field label={t('model.label')} htmlFor={`agent-team-model-${role.role}`}>
                <Select
                  value={role.publicModelId}
                  onValueChange={(value) => updateRole(role.role, { publicModelId: value })}
                >
                  <SelectTrigger id={`agent-team-model-${role.role}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TEAM_MODEL_SENTINEL}>{t('model.default')}</SelectItem>
                    {modelOptions.map((model) => (
                      <SelectItem key={model} value={model}>{model}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('entryPoints.label')} htmlFor={`agent-team-entry-points-${role.role}`}>
                <Textarea
                  id={`agent-team-entry-points-${role.role}`}
                  className="min-h-20"
                  value={role.entryPoints.join('\n')}
                  placeholder={t('entryPoints.placeholder')}
                  onChange={(event) => updateRole(role.role, {
                    entryPoints: event.target.value.split(/\r?\n/).map((line) => line.trim()),
                  })}
                />
              </Field>
              <div className="xl:col-span-2">
                <Field label={t('instructions.label')} htmlFor={`agent-team-instructions-${role.role}`}>
                  <Textarea
                    id={`agent-team-instructions-${role.role}`}
                    className="min-h-32"
                    value={role.instructions}
                    onChange={(event) => updateRole(role.role, { instructions: event.target.value })}
                  />
                </Field>
              </div>
              <fieldset className="min-w-0 space-y-2">
                <legend className="text-xs font-medium text-foreground">{t('skills.label')}</legend>
                {skillsQuery.isLoading ? <Skeleton className="h-20 w-full" /> : (skillsQuery.data ?? []).length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">{t('skills.empty')}</p>
                ) : (skillsQuery.data ?? []).map((skill) => (
                  <label key={skill.id} className="flex min-w-0 items-start gap-2 text-[13px]">
                    <Checkbox
                      className="mt-0.5"
                      checked={role.skillIds.includes(skill.id)}
                      onCheckedChange={(checked) => updateRole(role.role, {
                        skillIds: toggleSelection(role.skillIds, skill.id, checked === true),
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
                  <label key={server.id} className="flex min-w-0 items-start gap-2 text-[13px]">
                    <Checkbox
                      className="mt-0.5"
                      checked={role.mcpServerIds.includes(server.id)}
                      onCheckedChange={(checked) => updateRole(role.role, {
                        mcpServerIds: toggleSelection(role.mcpServerIds, server.id, checked === true),
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
                  {ROLE_TOOLS[role.role].map((tool) => (
                    <label key={tool} className="flex items-center gap-2 text-[13px]">
                      <Checkbox
                        checked={role.toolNames.includes(tool)}
                        onCheckedChange={(checked) => updateRole(role.role, {
                          toolNames: toggleSelection(role.toolNames, tool, checked === true),
                        })}
                      />
                      <span className="font-mono break-all">{tool}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </article>
        ))}
      </form>
    </div>
  );
}
