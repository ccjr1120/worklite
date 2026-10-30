import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError, api } from '@/api/client';
import { mcpServersQueryKey } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { queryClient } from '@/lib/query-client';
import type { McpServerReferenceReport } from '@worklite/contracts';

type McpServerDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  name: string;
  onDeleted: () => void;
};

function hasHardBlocks(references: McpServerReferenceReport) {
  return references.agents.length > 0 || references.activeChatTurns;
}

function hasReferences(references: McpServerReferenceReport) {
  return (
    hasHardBlocks(references) ||
    references.workflowDrafts.length > 0 ||
    references.workflowVersions.length > 0 ||
    references.agentTeamRoles.length > 0 ||
    references.agentTeamVersions.length > 0
  );
}

function McpServerDeleteDialog({ open, onOpenChange, serverId, name, onDeleted }: McpServerDeleteDialogProps) {
  const { t } = useTranslation(['mcpServers', 'common']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [references, setReferences] = useState<McpServerReferenceReport | null>(null);
  const [force, setForce] = useState(false);

  function close(nextOpen: boolean) {
    if (busy) return;
    if (!nextOpen) {
      setError('');
      setReferences(null);
      setForce(false);
    }
    onOpenChange(nextOpen);
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteMcpServer('personal', serverId, { force });
      close(false);
      toast.success(t('delete.success'));
      await queryClient.invalidateQueries({ queryKey: mcpServersQueryKey() });
      onDeleted();
    } catch (caught) {
      if (caught instanceof ApiError && caught.references) {
        setReferences(caught.references);
        setError('');
      } else {
        setError(caught instanceof Error ? caught.message : t('delete.failed'));
      }
    } finally {
      setBusy(false);
    }
  }

  const blocked = references !== null && hasHardBlocks(references);
  const forceAvailable = references !== null && hasReferences(references) && !blocked;
  const immutableOnly =
    references !== null &&
    !blocked &&
    references.workflowDrafts.length === 0 &&
    references.agentTeamRoles.length === 0 &&
    (references.workflowVersions.length > 0 || references.agentTeamVersions.length > 0);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={close}
      title={t('delete.title', { name })}
      description={t('delete.description')}
      confirmLabel={t('common:actions.delete')}
      cancelLabel={t('common:actions.cancel')}
      busyLabel={t('delete.deleting')}
      error={error}
      busy={busy}
      onConfirm={() => void confirm()}
    >
      {references && hasReferences(references) ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px]" role="alert">
            <p className="font-medium text-danger">{t('delete.references.title')}</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-danger">
              {references.agents.map((agent) => (
                <li key={agent.agentId}>{t('delete.references.agent', { name: agent.agentName })}</li>
              ))}
              {references.activeChatTurns ? <li>{t('delete.references.activeChatTurns')}</li> : null}
              {references.workflowDrafts.map((draft) => (
                <li key={`draft-${draft.workflowId}`}>
                  {t('delete.references.workflowDraft', { name: draft.workflowName, nodes: draft.nodeIds.join(', ') })}
                </li>
              ))}
              {references.workflowVersions.map((version) => (
                <li key={`version-${version.workflowId}-${version.version}`}>
                  {t('delete.references.workflowVersion', { name: version.workflowName, version: version.version, nodes: version.nodeIds.join(', ') })}
                </li>
              ))}
              {references.agentTeamRoles.map((role) => (
                <li key={`role-${role.coderId}-${role.role}`}>
                  {t('delete.references.agentTeamRole', { team: role.teamName, role: role.displayName ?? role.role })}
                </li>
              ))}
              {references.agentTeamVersions.map((version) => (
                <li key={`team-version-${version.versionId}`}>
                  {t('delete.references.agentTeamVersion', { version: version.version, roles: version.roles.join(', ') })}
                </li>
              ))}
            </ul>
          </div>
          {blocked ? <p className="text-[13px] text-muted-foreground">{t('delete.force.blockedNote')}</p> : null}
          {forceAvailable ? (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-start gap-2 text-[13px]">
                <Checkbox className="mt-0.5" checked={force} onCheckedChange={(checked) => setForce(checked === true)} disabled={busy} />
                <span>{immutableOnly ? t('delete.force.immutableLabel') : t('delete.force.label')}</span>
              </label>
              <p className="pl-6 text-xs text-muted-foreground">{t('delete.force.immutableNote')}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

export { McpServerDeleteDialog };
