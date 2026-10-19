import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentTeamView,
  AgentTeamRoleId,
  AgentTeamRoleConfiguration,
  ProjectExecutor,
} from '@worklite/contracts';
import { ApiError, api } from '@/api/client';
import {
  agentTeamQueryKey,
  useAgentTeamQuery,
  useModelProvidersQuery,
} from '@/api/queries';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageHeading } from '@/components/page-heading';
import { SaveIndicator } from '@/components/save-indicator';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { TeamRecords } from './team-records';
import { TeamMemoriesSettings } from './team-memories';
import { queryClient } from '@/lib/query-client';

const TEAM_MODEL_SENTINEL = '__team_default__';
const DEFAULT_MAX_CONCURRENT_RUNS = 3;
const BUILT_IN_ROLES: AgentTeamRoleId[] = ['planner', 'test_designer', 'developer', 'test_author', 'test_runner', 'reviewer', 'worktree-manager', 'team-manager'];
const EXECUTORS: ProjectExecutor[] = ['claude', 'codex'];

function toDraftRoles(roles: readonly AgentTeamRoleConfiguration[]): AgentTeamRoleConfiguration[] {
  return roles.map((source) => ({
    ...source,
    publicModelId: source.publicModelId || TEAM_MODEL_SENTINEL,
  }));
}

function toPersistedRoles(roles: readonly AgentTeamRoleConfiguration[]): AgentTeamRoleConfiguration[] {
  return roles.map((source) => ({ ...source, publicModelId: source.publicModelId === TEAM_MODEL_SENTINEL ? '' : source.publicModelId, entryPoints: source.entryPoints.filter(Boolean) }));
}

function ExecutorSelect({ id, value, onChange }: { id: string; value: ProjectExecutor | 'model'; onChange: (value: ProjectExecutor | 'model') => void }) {
  const { t } = useTranslation('agentTeams');
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ProjectExecutor | 'model')}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="model">{t('team.executor.model')}</SelectItem>
        {EXECUTORS.map((executor) => (
          <SelectItem key={executor} value={executor}>{t(`team.executor.${executor}`)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelSelect({ id, value, modelGroups, onChange, disabled }: {
  id: string;
  value: string;
  modelGroups: Array<{ name: string; models: string[] }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('agentTeams');
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} disabled={disabled}>
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

export function TeamDetailPage({ teamId, view }: { teamId: string; view: 'records' | 'configuration' }) {
  const { t } = useTranslation('agentTeams');
  const navigate = useNavigate();
  const workspaceSlug = 'personal';
  const teamQuery = useAgentTeamQuery(workspaceSlug, teamId);
  const providersQuery = useModelProvidersQuery(workspaceSlug);
  const [draftTeamId, setDraftTeamId] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<AgentTeamRoleConfiguration[]>([]);
  const [maxConcurrentRunsDraft, setMaxConcurrentRunsDraft] = useState(String(DEFAULT_MAX_CONCURRENT_RUNS));
  const [workingPracticeDraft, setWorkingPracticeDraft] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [saveNotice, setSaveNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const draftRevisionRef = useRef(0);

  useEffect(() => {
    if (!teamQuery.data || draftTeamId === teamQuery.data.id) return;
    setDraftTeamId(teamQuery.data.id);
    setRoleDrafts(toDraftRoles(teamQuery.data.roles));
    setMaxConcurrentRunsDraft(String(teamQuery.data.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS));
    setWorkingPracticeDraft(teamQuery.data.workingPractice ?? '');
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

  function updateRole(role: AgentTeamRoleId, changes: Partial<AgentTeamRoleConfiguration>) {
    draftRevisionRef.current += 1;
    setRoleDrafts((current) => current.map((item) => (item.role === role ? { ...item, ...changes } : item)));
    markUnsaved();
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
      const parsedLimit = Number.parseInt(maxConcurrentRunsDraft, 10);
      const maxConcurrentRuns = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? parsedLimit : DEFAULT_MAX_CONCURRENT_RUNS;
      const saved: AgentTeamView = await api.updateAgentTeam(teamId, {
        roles: toPersistedRoles(roleDrafts),
        maxConcurrentRuns,
        workingPractice: workingPracticeDraft,
      });
      const draftsChangedDuringSave = draftRevisionRef.current !== draftRevision;
      setRoleDrafts((current) => (draftsChangedDuringSave ? current : toDraftRoles(saved.roles)));
      if (!draftsChangedDuringSave) {
        setMaxConcurrentRunsDraft(String(saved.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS));
        setWorkingPracticeDraft(saved.workingPractice ?? '');
      }
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
        <WorkspaceChrome crumbs={view === 'configuration'
          ? [{ label: t('title'), to: `/agent-teams/${teamId}` }, { label: t('configuration.title') }]
          : [{ label: t('title') }]} />
        {view === 'configuration' ? (
          <div className="space-y-4" role="status" aria-busy="true" aria-live="polite">
            <span className="sr-only">{t('loading')}</span>
            <Skeleton className="h-8 w-72" />
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
              <Skeleton className="h-80 w-full" />
              <Skeleton className="h-80 w-full" />
            </div>
            {BUILT_IN_ROLES.map((role) => <Skeleton key={role} className="h-72 w-full" />)}
          </div>
        ) : (
          <div className="space-y-3" role="status" aria-busy="true" aria-live="polite">
            <span className="sr-only">{t('loading')}</span>
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </div>
    );
  }

  const notFound = teamQuery.isError && teamQuery.error instanceof ApiError && teamQuery.error.status === 404;
  if (notFound || (!teamQuery.isError && !teamQuery.data)) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={view === 'configuration'
          ? [{ label: t('title'), to: `/agent-teams/${teamId}` }, { label: t('configuration.title') }]
          : [{ label: t('title') }]} />
        <EmptyState title={t('unavailable.title')} description={t('unavailable.description')} />
      </div>
    );
  }

  if (teamQuery.isError || !teamQuery.data) {
    return (
      <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
        <WorkspaceChrome crumbs={view === 'configuration'
          ? [{ label: t('title'), to: `/agent-teams/${teamId}` }, { label: t('configuration.title') }]
          : [{ label: t('title') }]} />
        <ErrorState title={t('title')} description={t('loadFailed')} onAction={() => void teamQuery.refetch()} />
      </div>
    );
  }

  const team = teamQuery.data;
  const crumbs = view === 'configuration'
    ? [{ label: t('title'), to: `/agent-teams/${teamId}` }, { label: team.name }, { label: t('configuration.title') }]
    : [{ label: t('title') }, { label: team.name }];
  const managerRole = roleDrafts.find((role) => role.role === 'team-manager');
  const workRoles = roleDrafts.filter((role) => role.role !== 'team-manager');

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-6 md:py-8">
      <WorkspaceChrome
        crumbs={crumbs}
        back={view === 'configuration' ? (
          <Button asChild variant="ghost" size="compact">
            <Link to="/agent-teams/$teamId" params={{ teamId }}>
              <ArrowLeft aria-hidden="true" />
              {t('configuration.backToRecords')}
            </Link>
          </Button>
        ) : undefined}
        status={view === 'configuration' ? <SaveIndicator state={saveState} /> : undefined}
        actions={view === 'configuration' ? (
          <div className="flex flex-col items-end gap-1">
            <Button type="submit" form="agent-team-configuration" size="compact" disabled={saving}>
              {saving ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
              {saving ? t('team.saving') : t('team.save')}
            </Button>
            {saveError ? <p className="text-[13px] text-danger" role="alert">{saveError}</p> : null}
          </div>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => void navigate({ to: '/agent-teams/$teamId/configuration', params: { teamId } })}
          >
            {t('configuration.open')}
          </Button>
        )}
      />
      <PageHeading
        title={view === 'configuration' ? t('configuration.title') : team.name}
        description={view === 'records' ? team.description : undefined}
      />
      {view === 'records' ? <TeamRecords teamId={teamId} /> : (
        <div className="mt-6">
          {providersQuery.isError ? (
            <ErrorState
              title={t('resources.providers')}
              description={t('resources.loadFailed')}
              onAction={() => void providersQuery.refetch()}
            />
          ) : null}
          <section className="mt-4 min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-process">
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
            <section className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs">
              <Field
                label={t('team.maxConcurrentRuns.label')}
                htmlFor="agent-team-max-concurrent-runs"
                hint={t('team.maxConcurrentRuns.hint')}
              >
                <Input
                  id="agent-team-max-concurrent-runs"
                  type="number"
                  min={1}
                  step={1}
                  className="w-32"
                  value={maxConcurrentRunsDraft}
                  onChange={(event) => {
                    setMaxConcurrentRunsDraft(event.target.value);
                    markUnsaved();
                  }}
                />
              </Field>
            </section>
            {managerRole ? (
              <section className="min-w-0 rounded-xl border border-border bg-surface p-4 shadow-xs" aria-labelledby="agent-team-manager">
                <h2 id="agent-team-manager" className="text-sm font-semibold">{t('role.team_manager')}</h2>
                <div className="mt-3 max-w-md">
                  <Field label={t('model.label')} htmlFor="agent-team-model-team-manager">
                    <ModelSelect
                      id="agent-team-model-team-manager"
                      value={managerRole.publicModelId}
                      modelGroups={modelGroups}
                      onChange={(value) => updateRole('team-manager', { publicModelId: value })}
                    />
                  </Field>
                </div>
                <div className="mt-4 border-t border-border pt-4">
                  <Field label={t('team.workingPractice.label')} htmlFor="agent-team-working-practice" hint={t('team.workingPractice.hint')}>
                    <Textarea
                      id="agent-team-working-practice"
                      className="min-h-28"
                      value={workingPracticeDraft}
                      onChange={(event) => {
                        setWorkingPracticeDraft(event.target.value);
                        markUnsaved();
                      }}
                    />
                  </Field>
                </div>
                <TeamMemoriesSettings teamId={team.id} />
              </section>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{t('team.roles')}</h2>
              {saveNotice ? <p role="status">{saveNotice}</p> : null}
            </div>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {workRoles.map((role) => (
                <section key={role.role} className="min-w-0 p-4" aria-labelledby={`agent-team-role-${role.role}`}>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1fr)] sm:items-center">
                    <h3 id={`agent-team-role-${role.role}`} className="text-sm font-semibold">{role.displayName ?? (BUILT_IN_ROLES.includes(role.role) ? t(`role.${role.role.replaceAll('-', '_')}`) : role.role)}</h3>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <Field label={t('model.label')} htmlFor={`agent-team-model-${role.role}`}>
                        <ModelSelect
                          id={`agent-team-model-${role.role}`}
                          value={role.publicModelId}
                          modelGroups={modelGroups}
                          onChange={(value) => updateRole(role.role, { publicModelId: value })}
                        />
                      </Field>
                      <Field label={t('team.executor.label')} htmlFor={`agent-team-executor-${role.role}`}>
                        <ExecutorSelect
                          id={`agent-team-executor-${role.role}`}
                          value={role.role === 'developer' ? role.executor ?? 'claude' : role.executor ?? 'model'}
                          onChange={(value) => updateRole(role.role, { executor: value === 'model' ? null : value })}
                        />
                      </Field>
                    </div>
                  </div>
                  {role.role === 'developer' ? (
                    <p className="mt-3 border-t border-border pt-3 text-[13px] text-muted-foreground">
                      {t('team.parallelism')}
                    </p>
                  ) : null}
                </section>
              ))}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
