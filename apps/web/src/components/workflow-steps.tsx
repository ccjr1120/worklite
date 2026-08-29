import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status-badge';
import type { WorkflowStep } from '@/mock/data';
import { cn } from '@/lib/utils';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type WorkflowStepsProps = {
  steps: WorkflowStep[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (index: number) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
};

function WorkflowSteps({ steps, selectedId, onSelect, onAdd, onMove, onDuplicate, onRemove }: WorkflowStepsProps) {
  const { t } = useTranslation('workflows');

  return (
    <ol className="flex flex-col">
      <li className="flex justify-center py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onAdd(0)} aria-label={t('editor.addStepStart')}>
          <Plus className="size-3.5" />
          {t('editor.addStep')}
        </Button>
      </li>
      {steps.map((step, index) => {
        const selected = step.id === selectedId;
        return (
          <li key={step.id} className="flex flex-col items-stretch">
            {index > 0 ? <div className="mx-auto h-6 w-px bg-border" aria-hidden="true" /> : null}
            <article
              className={cn(
                'rounded-lg border bg-surface p-4 transition-colors duration-[120ms]',
                selected ? 'border-brand' : 'border-border',
              )}
            >
              <button type="button" className={cn('w-full rounded-md text-left', surfaceInteraction, focusRingInset)} onClick={() => onSelect(step.id)} aria-pressed={selected}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">{t('editor.step', { position: step.position })}</p>
                    <h3 className="mt-1 text-sm font-semibold">{step.nodeType === 'text' ? 'Text' : step.agentName}</h3>
                    <p className="mt-1 font-mono text-[12px] text-muted-foreground">{step.nodeType === 'text' ? 'text' : step.agentVersion} · {step.inputSummary}</p>
                  </div>
                  {step.status ? <StatusBadge status={step.status} /> : null}
                </div>
              </button>
              <div className="mt-3 flex items-center gap-1 border-t border-border pt-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-compact" disabled={index === 0} onClick={() => onMove(step.id, -1)} aria-label={t('editor.moveUp')}>
                      <ArrowUp className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('editor.moveUp')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-compact" disabled={index === steps.length - 1} onClick={() => onMove(step.id, 1)} aria-label={t('editor.moveDown')}>
                      <ArrowDown className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('editor.moveDown')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-compact" onClick={() => onDuplicate(step.id)} aria-label={t('editor.duplicate')}>
                      <Copy className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('editor.duplicate')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon-compact" onClick={() => onRemove(step.id)} aria-label={t('editor.remove')}>
                      <Trash2 className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('editor.remove')}</TooltipContent>
                </Tooltip>
              </div>
            </article>
            <div className="flex justify-center py-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onAdd(index + 1)} aria-label={t('editor.addStepAfter', { name: step.agentName })}>
                <Plus className="size-3.5" />
                {t('editor.addStep')}
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export { WorkflowSteps };
