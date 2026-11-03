import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentPlanStep } from '@worklite/contracts';

export function ExecutionChecklist({ steps }: { steps: AgentPlanStep[] }) {
  const { t } = useTranslation('assistant');
  return <ul className="space-y-1 text-[13px] text-muted-foreground">
    {steps.map((item, index) => <li key={`${index}:${item.step}`} className="flex items-start gap-2">
      {item.status === 'completed' ? <CheckCircle2 className="wl-check-pop mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        : item.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 text-brand motion-safe:animate-spin" aria-hidden="true" />
          : <Circle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
      <span className="sr-only">{t(item.status === 'completed' ? 'status.completed' : item.status === 'in_progress' ? 'status.running' : 'status.queued')}：</span>
      <span className="break-words">{item.step}</span>
    </li>)}
  </ul>;
}

// Older snapshots used emoji markers. Keep them readable without showing emoji in the UI.
export function parseChecklistProgress(text: string): AgentPlanStep[] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return null;
  const steps: AgentPlanStep[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:- \[([ xX~])\]|(✅|🔄|○))\s+(.+?)\s*$/);
    if (!match) return null;
    const marker = match[1]?.toLowerCase() ?? match[2];
    steps.push({ step: match[3]!, status: marker === 'x' || marker === '✅' ? 'completed' : marker === '~' || marker === '🔄' ? 'in_progress' : 'pending' });
  }
  return steps;
}
