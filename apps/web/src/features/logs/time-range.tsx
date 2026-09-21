import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { focusRingInset } from '@/components/ui/interaction';
import { cn } from '@/lib/utils';

const RANGE_PRESETS = ['1h', '24h', '7d', '30d'] as const;

type RangePreset = (typeof RANGE_PRESETS)[number];

const PRESET_MS: Record<RangePreset, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const PRESET_LABEL_KEYS: Record<RangePreset, string> = {
  '1h': 'range.last1h',
  '24h': 'range.last24h',
  '7d': 'range.last7d',
  '30d': 'range.last30d',
};

/**
 * A preset is stored by name and a custom range by absolute instants. A shared
 * preset link must still mean "the last 24 hours" when it is opened, while a
 * shared custom range must mean the exact interval that was investigated.
 */
type LogsTimeRange =
  | { kind: 'preset'; preset: RangePreset }
  | { kind: 'custom'; from: string; to: string };

function isRangePreset(value: unknown): value is RangePreset {
  return typeof value === 'string' && RANGE_PRESETS.includes(value as RangePreset);
}

function resolveTimeRange(range: LogsTimeRange, now = Date.now()): { from: string; to: string } {
  if (range.kind === 'custom') return { from: range.from, to: range.to };
  return { from: new Date(now - PRESET_MS[range.preset]).toISOString(), to: new Date(now).toISOString() };
}

/** `datetime-local` reads and writes local wall-clock text without a zone suffix. */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function TimeRangeControl({ range, onRangeChange }: { range: LogsTimeRange; onRangeChange: (next: LogsTimeRange) => void }) {
  const { t } = useTranslation('logs');
  const fieldId = useId();
  const startId = `${fieldId}-start`;
  const endId = `${fieldId}-end`;
  const invalidId = `${fieldId}-invalid`;
  const resolved = resolveTimeRange(range);
  const [draft, setDraft] = useState(() => ({ start: toLocalInputValue(resolved.from), end: toLocalInputValue(resolved.to) }));

  // Switching to a custom range should start from what is already on screen, so
  // the fields follow the applied range until the reader edits them.
  useEffect(() => {
    const applied = resolveTimeRange(range);
    setDraft({ start: toLocalInputValue(applied.from), end: toLocalInputValue(applied.to) });
  }, [range]);

  const draftFrom = fromLocalInputValue(draft.start);
  const draftTo = fromLocalInputValue(draft.end);
  const inverted = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const applicable = Boolean(draftFrom && draftTo) && !inverted;

  function applyCustom() {
    if (!draftFrom || !draftTo || inverted) return;
    onRangeChange({ kind: 'custom', from: draftFrom, to: draftTo });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3 lg:flex-row lg:items-end lg:justify-between" aria-label={t('range.label')}>
      <div role="radiogroup" aria-label={t('range.label')} className="flex flex-wrap gap-1">
        {RANGE_PRESETS.map((preset) => {
          const selected = range.kind === 'preset' && range.preset === preset;
          return (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onRangeChange({ kind: 'preset', preset })}
              className={cn(
                'h-8 rounded-md px-3 text-[13px] transition-colors duration-[120ms]',
                selected ? 'bg-brand-subtle font-medium text-foreground' : 'text-muted-foreground hover:bg-surface-subtle hover:text-foreground',
                focusRingInset,
              )}
            >
              {t(PRESET_LABEL_KEYS[preset] as 'range.last24h')}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor={startId} className="text-xs font-medium text-muted-foreground">{t('range.start')}</label>
          <Input
            id={startId}
            type="datetime-local"
            value={draft.start}
            aria-invalid={inverted || undefined}
            aria-describedby={inverted ? invalidId : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, start: event.target.value }))}
            className="w-full sm:w-[200px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={endId} className="text-xs font-medium text-muted-foreground">{t('range.end')}</label>
          <Input
            id={endId}
            type="datetime-local"
            value={draft.end}
            aria-invalid={inverted || undefined}
            aria-describedby={inverted ? invalidId : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, end: event.target.value }))}
            className="w-full sm:w-[200px]"
          />
        </div>
        <Button type="button" variant="secondary" size="compact" onClick={applyCustom} disabled={!applicable} className="sm:mb-0.5">
          {t('range.apply')}
        </Button>
      </div>
      {inverted ? <p id={invalidId} role="alert" className="text-[13px] text-danger lg:basis-full lg:text-right">{t('range.invalid')}</p> : null}
    </section>
  );
}

export { TimeRangeControl, isRangePreset, resolveTimeRange, RANGE_PRESETS };
export type { LogsTimeRange, RangePreset };
