import { LoaderCircle, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  workflowNodeRequiresSideEffectConfirmation,
  workflowRerunAffectedNodeIds,
  type RerunWorkflowNodeRequest,
  type RunView,
  type WorkflowDefinition,
  type WorkflowNodeRunView,
} from '@worklite/contracts';
import { ApiError, api } from '@/api/client';
import { useModelProvidersQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { queryClient } from '@/lib/query-client';

const KEEP_CURRENT_MODEL = '__worklite_keep_current_model__';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type NodeRerunDialogProps = {
  run: RunView;
  nodeRun: WorkflowNodeRunView;
  definition: WorkflowDefinition;
  nodeLabel: string;
  nodeLabels: ReadonlyMap<string, string>;
  onClose: () => void;
};

function NodeRerunDialog({ run, nodeRun, definition, nodeLabel, nodeLabels, onClose }: NodeRerunDialogProps) {
  const { t } = useTranslation(['runs', 'common']);
  const { data: providers = [], isLoading: providersLoading } = useModelProvidersQuery('personal');
  const targetNode = definition.nodes.find((node) => node.id === nodeRun.nodeId);
  const isAgent = targetNode?.type === 'worklite/agent';
  const configuredModel = asRecord(targetNode?.config)?.model;
  const currentModel = typeof configuredModel === 'string' && configuredModel.trim() ? configuredModel : null;
  const [modelSelection, setModelSelection] = useState(currentModel ?? KEEP_CURRENT_MODEL);
  const [sideEffectsConfirmed, setSideEffectsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const affectedNodeIds = useMemo(
    () => new Set<string>(workflowRerunAffectedNodeIds(definition, nodeRun.nodeId)),
    [definition, nodeRun.nodeId],
  );
  const downstreamNodeIds = useMemo(() => new Set(
    (run.nodeRuns ?? [])
      .filter((item) => item.id !== nodeRun.id && item.nodeId !== nodeRun.nodeId && item.status !== 'superseded' && affectedNodeIds.has(item.nodeId))
      .map((item) => item.nodeId),
  ), [affectedNodeIds, nodeRun.id, nodeRun.nodeId, run.nodeRuns]);
  const downstreamNodes = definition.nodes.filter((node) => downstreamNodeIds.has(node.id));
  const requiresSideEffectConfirmation = definition.nodes.some(
    (node) => affectedNodeIds.has(node.id) && workflowNodeRequiresSideEffectConfirmation(node.type),
  );
  const modelOptions = useMemo(() => {
    const options = providers
      .filter((provider) => provider.protocol !== 'typesafe/systemone')
      .flatMap((provider) => provider.models.map((model) => `${provider.name}/${model}`));
    if (currentModel && !options.includes(currentModel)) options.unshift(currentModel);
    return [...new Set(options)];
  }, [currentModel, providers]);

  function errorMessage(failure: unknown): string {
    if (failure instanceof ApiError && failure.code) {
      if (failure.code === 'RUN_NODE_RERUN_NOT_ALLOWED') return t('runs:nodeRerun.errors.notAllowed');
      if (failure.code === 'RUN_NODE_RERUN_NODE_NOT_ELIGIBLE') return t('runs:nodeRerun.errors.nodeNotEligible');
      if (failure.code === 'RUN_NODE_RERUN_INVALID_MODEL') return t('runs:nodeRerun.errors.invalidModel');
      if (failure.code === 'RUN_NODE_RERUN_SIDE_EFFECT_CONFIRMATION_REQUIRED') return t('runs:nodeRerun.errors.sideEffectConfirmationRequired');
      if (failure.code === 'RUN_NODE_RERUN_STATE_UNAVAILABLE') return t('runs:nodeRerun.errors.stateUnavailable');
    }
    return failure instanceof Error && failure.message ? failure.message : t('runs:nodeRerun.failed');
  }

  async function rerun() {
    if (busy || (requiresSideEffectConfirmation && !sideEffectsConfirmed)) return;
    setBusy(true);
    setError(null);
    const input: RerunWorkflowNodeRequest = {
      ...(isAgent && modelSelection !== KEEP_CURRENT_MODEL ? { modelOverride: modelSelection } : {}),
      ...(requiresSideEffectConfirmation ? { confirmSideEffects: true } : {}),
    };
    try {
      const next = await api.rerunRunNode('personal', run.id, nodeRun.id, input);
      queryClient.setQueryData(['run', run.id], next);
      void queryClient.invalidateQueries({ queryKey: ['runs'] }).catch(() => undefined);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent aria-busy={busy}>
        <DialogHeader>
          <DialogTitle>{t('runs:nodeRerun.title', { node: nodeLabel })}</DialogTitle>
          <DialogDescription>{t('runs:nodeRerun.description')}</DialogDescription>
        </DialogHeader>

        {isAgent ? (
          <div className="grid gap-2">
            <Label htmlFor="node-rerun-model">{t('runs:nodeRerun.model')}</Label>
            <Select value={modelSelection} onValueChange={setModelSelection} disabled={busy || providersLoading}>
              <SelectTrigger id="node-rerun-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {!currentModel ? <SelectItem value={KEEP_CURRENT_MODEL}>{t('runs:nodeRerun.keepCurrentModel')}</SelectItem> : null}
                {modelOptions.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <section aria-labelledby="node-rerun-downstream-title">
          <h3 id="node-rerun-downstream-title" className="text-sm font-medium">{t('runs:nodeRerun.downstreamTitle')}</h3>
          {downstreamNodes.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-[13px] text-muted-foreground">
              {downstreamNodes.map((node) => <li key={node.id}>{nodeLabels.get(node.id) ?? node.id}</li>)}
            </ul>
          ) : <p className="mt-2 text-[13px] text-muted-foreground">{t('runs:nodeRerun.noDownstream')}</p>}
        </section>

        {requiresSideEffectConfirmation ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
            <Checkbox
              id="node-rerun-side-effects"
              checked={sideEffectsConfirmed}
              onCheckedChange={(checked) => setSideEffectsConfirmed(checked === true)}
              disabled={busy}
            />
            <Label htmlFor="node-rerun-side-effects" className="leading-5">{t('runs:nodeRerun.confirmSideEffects')}</Label>
          </div>
        ) : null}

        {error ? <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger" role="alert">{error}</p> : null}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t('common:actions.cancel')}</Button>
          <Button type="button" onClick={() => void rerun()} disabled={busy || (requiresSideEffectConfirmation && !sideEffectsConfirmed)}>
            {busy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
            {busy ? t('runs:nodeRerun.submitting') : t('runs:nodeRerun.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { NodeRerunDialog };
export type { NodeRerunDialogProps };
