import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { AgentTeamRoleConfiguration, SkillView } from '@worklite/contracts';
import { api } from '@/api/client';
import { useAgentTeamMemoriesQuery, useAgentTeamQuery, useMcpServersQuery, useSkillsQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { queryClient } from '@/lib/query-client';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { PageContainer, PageHeading } from '@/components/page-heading';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import { TeamSwitcher } from './team-switcher';

function roleLabel(role: string, t: (key: string) => string) {
  return t(`role.${role.replaceAll('-', '_')}`);
}

function NotSet({ label }: { label: string }) {
  return <span className="text-muted-foreground">{label}</span>;
}

function StringList({ items, notSet, mono = false }: { items: string[]; notSet: string; mono?: boolean }) {
  if (!items.length) return <NotSet label={notSet} />;
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item} className={mono ? 'font-mono text-xs break-all' : 'break-words'}>{item}</li>
      ))}
    </ul>
  );
}

function RoleCard({ teamId, role, skills, mcpServerNames }: { teamId: string; role: AgentTeamRoleConfiguration; skills: SkillView[]; mcpServerNames: Map<string, string> }) {
  const { t } = useTranslation(['agentTeams', 'skills']);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState(role.skillIds);
  const [savingSkills, setSavingSkills] = useState(false);
  const [skillsError, setSkillsError] = useState('');
  const notSet = t('config.notSet');
  const mcpServers = role.mcpServerIds.map((id) => mcpServerNames.get(id) ?? id);
  const skillOptions = useMemo(() => {
    const known = new Map(skills.map((skill) => [skill.id, skill]));
    const missing = role.skillIds
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: id } as Pick<SkillView, 'id' | 'name'> & { source?: SkillView['source'] }));
    return [...skills, ...missing];
  }, [role.skillIds, skills]);
  const skillsDirty = [...selectedSkillIds].sort().join('\0') !== [...role.skillIds].sort().join('\0');

  useEffect(() => {
    setSelectedSkillIds(role.skillIds);
  }, [role.skillIds]);

  async function saveSkills() {
    if (!skillsDirty || savingSkills) return;
    setSavingSkills(true);
    setSkillsError('');
    try {
      await api.updateAgentTeamRole(teamId, role.role, { skillIds: selectedSkillIds });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-team', teamId] }),
        queryClient.invalidateQueries({ queryKey: ['agent-teams'] }),
      ]);
      toast.success(t('config.roles.skillsSaved'));
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : t('config.roles.skillsSaveFailed'));
    } finally {
      setSavingSkills(false);
    }
  }

  return (
    <article className="rounded-xl border border-border bg-surface p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{role.displayName ?? roleLabel(role.role, (key) => t(key as never))}</h3>
        <span className="font-mono text-xs text-muted-foreground break-all">{role.role}</span>
      </div>
      <dl className="mt-3 grid gap-4 text-[13px] md:grid-cols-2">
        <div><dt className="text-muted-foreground">{t('config.roles.model')}</dt><dd className="mt-1 font-mono break-all">{Array.isArray(role.publicModelId) ? role.publicModelId.join(', ') : role.publicModelId || <NotSet label={notSet} />}</dd></div>
        <div><dt className="text-muted-foreground">{t('config.roles.executor')}</dt><dd className="mt-1">{role.executor ?? <NotSet label={notSet} />}</dd></div>
        <div><dt className="text-muted-foreground">{t('config.roles.entryPoints')}</dt><dd className="mt-1"><StringList items={role.entryPoints} notSet={notSet} mono /></dd></div>
        <div className="md:col-span-2">
          <dt className="text-muted-foreground">{t('config.roles.skills')}</dt>
          <dd className="mt-1">
            {skillOptions.length === 0 ? <NotSet label={notSet} /> : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {skillOptions.map((skill) => (
                  <label key={skill.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                    <Checkbox
                      checked={selectedSkillIds.includes(skill.id)}
                      onCheckedChange={(checked) => {
                        setSkillsError('');
                        setSelectedSkillIds((current) => checked === true
                          ? [...new Set([...current, skill.id])]
                          : current.filter((id) => id !== skill.id));
                      }}
                      aria-label={skill.name}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{skill.name}</span>
                    {'root' in skill ? <Badge variant="neutral">{t(`skills:root.${skill.root}` as never)}</Badge> : null}
                  </label>
                ))}
              </div>
            )}
            {skillsDirty ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button type="button" size="compact" onClick={() => void saveSkills()} disabled={savingSkills}>
                  {savingSkills ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                  {t('config.roles.saveSkills')}
                </Button>
                <Button type="button" size="compact" variant="ghost" onClick={() => { setSelectedSkillIds(role.skillIds); setSkillsError(''); }} disabled={savingSkills}>
                  {t('config.roles.cancelSkills')}
                </Button>
              </div>
            ) : skillOptions.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">{t('config.roles.skillsApplyNextRun')}</p> : null}
            {skillsError ? <p role="alert" className="mt-1.5 text-xs text-danger">{skillsError}</p> : null}
          </dd>
        </div>
        <div><dt className="text-muted-foreground">{t('config.roles.mcpServers')}</dt><dd className="mt-1"><StringList items={mcpServers} notSet={notSet} /></dd></div>
        <div><dt className="text-muted-foreground">{t('config.roles.tools')}</dt><dd className="mt-1"><StringList items={role.toolNames} notSet={notSet} mono /></dd></div>
      </dl>
      <Collapsible open={instructionsOpen} onOpenChange={setInstructionsOpen} className="mt-4">
        <CollapsibleTrigger className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground hover:text-foreground">
          <ChevronDown className={instructionsOpen ? 'size-4 rotate-180 transition-transform' : 'size-4 transition-transform'} aria-hidden="true" />
          {instructionsOpen ? t('config.roles.hideInstructions') : t('config.roles.showInstructions')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {role.instructions ? (
            <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-surface-subtle p-3 font-mono text-xs whitespace-pre-wrap break-words">{role.instructions}</pre>
          ) : (
            <p className="mt-2 text-[13px]"><NotSet label={notSet} /></p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

export function TeamConfig({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const { locale } = useLocale();
  const teamQuery = useAgentTeamQuery(teamId);
  const memoriesQuery = useAgentTeamMemoriesQuery(teamId);
  const mcpServersQuery = useMcpServersQuery('personal');
  const skillsQuery = useSkillsQuery('personal');
  const notSet = t('config.notSet');
  const recordsPath = `/agent-teams/${encodeURIComponent(teamId)}`;
  const crumbs = [{ label: t('title') }, ...(teamQuery.data ? [{ label: teamQuery.data.name, to: recordsPath }] : []), { label: t('config.title') }];

  if (teamQuery.isPending) {
    return (
      <PageContainer width="detail">
        <WorkspaceChrome crumbs={crumbs} />
        <div className="space-y-3" role="status"><Skeleton className="h-8 w-72" /><Skeleton className="h-24 w-full" /><Skeleton className="h-56 w-full" /></div>
      </PageContainer>
    );
  }
  if (teamQuery.isError || !teamQuery.data) {
    return (
      <PageContainer width="detail">
        <WorkspaceChrome crumbs={crumbs} />
        <TeamSwitcher teamId={teamId} />
        <ErrorState title={t('config.title')} description={t('config.loadFailed')} onAction={() => void teamQuery.refetch()} />
      </PageContainer>
    );
  }

  const team = teamQuery.data;
  const mcpServerNames = new Map((mcpServersQuery.data ?? []).map((server) => [server.id, server.name]));
  const availableSkills = skillsQuery.data ?? [];

  return (
    <PageContainer width="detail">
      <WorkspaceChrome crumbs={crumbs} />
      <PageHeading
        title={t('config.title')}
        description={t('config.description')}
        actions={<Link to="/agent-teams/$teamId" params={{ teamId }} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">{t('config.backToRecords')}</Link>}
      />
      <TeamSwitcher teamId={teamId} />

      <section className="rounded-xl border border-border bg-surface p-4 shadow-xs">
        <h2 className="text-sm font-semibold">{t('config.overview.title')}</h2>
        <dl className="mt-3 grid gap-4 text-[13px] md:grid-cols-2">
          <div><dt className="text-muted-foreground">{t('config.overview.name')}</dt><dd className="mt-1 break-words">{team.name || <NotSet label={notSet} />}</dd></div>
          <div><dt className="text-muted-foreground">{t('config.overview.description')}</dt><dd className="mt-1 break-words">{team.description || <NotSet label={notSet} />}</dd></div>
          <div><dt className="text-muted-foreground">{t('config.overview.processId')}</dt><dd className="mt-1 font-mono break-all">{team.processId || <NotSet label={notSet} />}</dd></div>
          <div><dt className="text-muted-foreground">{t('config.overview.processVersion')}</dt><dd className="mt-1 font-mono">{team.processVersion || <NotSet label={notSet} />}</dd></div>
          <div><dt className="text-muted-foreground">{t('config.overview.maxConcurrentRuns')}</dt><dd className="mt-1 tabular-nums">{team.maxConcurrentRuns}</dd></div>
          <div><dt className="text-muted-foreground">{t('config.overview.createdAt')}</dt><dd className="mt-1">{formatDateTime(team.createdAt, locale)}</dd></div>
          <div><dt className="text-muted-foreground">{t('config.overview.updatedAt')}</dt><dd className="mt-1">{formatDateTime(team.updatedAt, locale)}</dd></div>
          <div className="md:col-span-2"><dt className="text-muted-foreground">{t('config.overview.workingPractice')}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{team.workingPractice || <NotSet label={notSet} />}</dd></div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t('config.roles.title')}</h2>
        {team.roles.length ? team.roles.map((role) => <RoleCard key={role.role} teamId={teamId} role={role} skills={availableSkills} mcpServerNames={mcpServerNames} />) : <EmptyState title={t('config.roles.title')} description={t('config.roles.empty')} />}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t('config.memories.title')}</h2>
        {memoriesQuery.isPending ? (
          <div className="space-y-3" role="status"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : memoriesQuery.isError ? (
          <ErrorState title={t('config.memories.title')} description={t('config.memories.loadFailed')} onAction={() => void memoriesQuery.refetch()} />
        ) : memoriesQuery.data.length ? (
          memoriesQuery.data.map((memory) => (
            <article key={memory.id} className="rounded-xl border border-border bg-surface p-4 shadow-xs">
              <p className="whitespace-pre-wrap break-words text-[13px]">{memory.content}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{memory.role ? roleLabel(memory.role, (key) => t(key as never)) : t('config.memories.allRoles')}</span>
                {memory.repositoryName ? <span>{memory.repositoryName}</span> : null}
                <span>{formatDateTime(memory.updatedAt, locale)}</span>
              </div>
            </article>
          ))
        ) : (
          <EmptyState title={t('config.memories.title')} description={t('config.memories.empty')} />
        )}
      </section>
    </PageContainer>
  );
}
