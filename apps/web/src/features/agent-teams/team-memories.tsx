import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { agentTeamMemoriesQueryKey, useAgentTeamMemoriesQuery, useAgentTeamRepositoriesQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const TEAM_SCOPE = '__team_scope__';

// Rendered inside the Team Manager section of the configuration form, so every
// control is type="button" and creation runs from click handlers instead of a
// nested form element.
export function TeamMemoriesSettings({ teamId }: { teamId: string }) {
  const { t } = useTranslation('agentTeams');
  const queryClient = useQueryClient();
  const memoriesQuery = useAgentTeamMemoriesQuery(teamId);
  const repositoriesQuery = useAgentTeamRepositoriesQuery(teamId);
  const [content, setContent] = useState('');
  const [repositoryId, setRepositoryId] = useState(TEAM_SCOPE);
  const [editingId, setEditingId] = useState('');
  const [editContent, setEditContent] = useState('');
  const [workingId, setWorkingId] = useState('');
  const [error, setError] = useState('');

  async function createMemory() {
    const value = content.trim();
    if (!value || workingId) return;
    setWorkingId('create');
    setError('');
    try {
      await api.createAgentTeamMemory(teamId, {
        content: value,
        repositoryId: repositoryId === TEAM_SCOPE ? null : repositoryId,
        role: null,
      });
      await queryClient.invalidateQueries({ queryKey: agentTeamMemoriesQueryKey(teamId) });
      setContent('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memories.saveFailed'));
    } finally {
      setWorkingId('');
    }
  }

  async function saveMemory(memoryId: string) {
    const value = editContent.trim();
    if (!value || workingId) return;
    setWorkingId(memoryId);
    setError('');
    try {
      await api.updateAgentTeamMemory(teamId, memoryId, { content: value });
      await queryClient.invalidateQueries({ queryKey: agentTeamMemoriesQueryKey(teamId) });
      setEditingId('');
      setEditContent('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memories.saveFailed'));
    } finally {
      setWorkingId('');
    }
  }

  async function removeMemory(memoryId: string) {
    if (workingId) return;
    setWorkingId(memoryId);
    setError('');
    try {
      await api.deleteAgentTeamMemory(teamId, memoryId);
      await queryClient.invalidateQueries({ queryKey: agentTeamMemoriesQueryKey(teamId) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memories.deleteFailed'));
    } finally {
      setWorkingId('');
    }
  }

  return (
    <div className="mt-4 border-t border-border pt-4" aria-labelledby="agent-team-memories">
      <h3 id="agent-team-memories" className="text-sm font-semibold">{t('memories.title')}</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">{t('memories.description')}</p>
      {error ? <p className="mt-2 text-[13px] text-danger" role="alert">{error}</p> : null}
      <div className="mt-3 space-y-3">
        <Field label={t('memories.content')} htmlFor="agent-team-memory-content">
          <Textarea id="agent-team-memory-content" className="min-h-20" value={content} onChange={(event) => setContent(event.target.value)} placeholder={t('memories.placeholder')} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('memories.repository')} htmlFor="agent-team-memory-repository">
            <Select value={repositoryId} onValueChange={setRepositoryId}>
              <SelectTrigger id="agent-team-memory-repository"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={TEAM_SCOPE}>{t('memories.allRepositories')}</SelectItem>
                {(repositoriesQuery.data ?? []).map((repository) => <SelectItem key={repository.id} value={repository.id}>{repository.name} — {repository.directory}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button type="button" size="compact" disabled={!content.trim() || workingId === 'create'} onClick={() => void createMemory()}>
          {workingId === 'create' ? t('memories.saving') : t('memories.add')}
        </Button>
      </div>

      {memoriesQuery.isLoading ? <p className="mt-3 text-[13px] text-muted-foreground">{t('memories.loading')}</p> : null}
      {memoriesQuery.isError ? <p className="mt-3 text-[13px] text-danger">{t('memories.loadFailed')}</p> : null}
      {!memoriesQuery.isLoading && !memoriesQuery.isError && (memoriesQuery.data ?? []).length === 0 ? <p className="mt-3 text-[13px] text-muted-foreground">{t('memories.empty')}</p> : null}
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border empty:hidden">
        {(memoriesQuery.data ?? []).map((memory) => (
          <li key={memory.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{memory.repositoryName ? `${memory.repositoryName} · ${memory.repositoryDirectory}` : t('memories.allRepositories')}</span>
              <span>{new Date(memory.updatedAt).toLocaleString()}</span>
            </div>
            {editingId === memory.id ? (
              <Textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} aria-label={t('memories.editContent')} />
            ) : <p className="whitespace-pre-wrap text-[13px] leading-5">{memory.content}</p>}
            <div className="flex flex-wrap gap-2">
              {editingId === memory.id ? (
                <>
                  <Button type="button" size="compact" disabled={!editContent.trim() || workingId === memory.id} onClick={() => void saveMemory(memory.id)}>{workingId === memory.id ? t('memories.saving') : t('memories.save')}</Button>
                  <Button type="button" size="compact" variant="outline" disabled={workingId === memory.id} onClick={() => { setEditingId(''); setEditContent(''); }}>{t('memories.cancel')}</Button>
                </>
              ) : <Button type="button" size="compact" variant="outline" disabled={Boolean(workingId)} onClick={() => { setEditingId(memory.id); setEditContent(memory.content); }}>{t('memories.edit')}</Button>}
              <Button type="button" size="compact" variant="outline" disabled={Boolean(workingId)} onClick={() => void removeMemory(memory.id)}>{workingId === memory.id ? t('memories.deleting') : t('memories.delete')}</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
