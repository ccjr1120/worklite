import { Ban, CheckCircle2, CircleDashed, Hourglass, LoaderCircle, Pause, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type RunUiStatus = 'queued' | 'running' | 'paused' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled' | 'superseded';

type StatusKey =
  | RunUiStatus
  | 'idle'
  | 'draft'
  | 'published'
  | 'connected'
  | 'disabled'
  | 'disconnected'
  | 'unreachable'
  | 'auth_failed'
  | 'unconfigured'
  | 'valid'
  | 'invalid'
  | 'pending'
  | 'available'
  | 'missing'
  | 'qr_pending'
  | 'error'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'gateway_running';

type StatusTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

// `live` statuses show the breathing live dot instead of a static icon, so ongoing
// work reads as motion and settled work reads as a still mark.
type StatusMeta = { tone: StatusTone; icon: typeof CheckCircle2; live?: boolean; spin?: boolean; pop?: boolean };

const STATUS_CONFIG: Record<StatusKey, StatusMeta> = {
  queued: { tone: 'neutral', icon: CircleDashed },
  running: { tone: 'brand', icon: LoaderCircle, live: true },
  paused: { tone: 'warning', icon: Pause },
  waiting_for_input: { tone: 'warning', icon: Hourglass, live: true },
  completed: { tone: 'success', icon: CheckCircle2, pop: true },
  failed: { tone: 'danger', icon: XCircle },
  cancelled: { tone: 'neutral', icon: Ban },
  superseded: { tone: 'neutral', icon: CircleDashed },
  idle: { tone: 'neutral', icon: CircleDashed },
  draft: { tone: 'neutral', icon: CircleDashed },
  published: { tone: 'success', icon: CheckCircle2 },
  connected: { tone: 'success', icon: CheckCircle2, live: true },
  disabled: { tone: 'neutral', icon: Ban },
  disconnected: { tone: 'neutral', icon: CircleDashed },
  unreachable: { tone: 'danger', icon: XCircle },
  auth_failed: { tone: 'danger', icon: XCircle },
  unconfigured: { tone: 'neutral', icon: CircleDashed },
  valid: { tone: 'success', icon: CheckCircle2 },
  invalid: { tone: 'danger', icon: XCircle },
  pending: { tone: 'info', icon: LoaderCircle, spin: true },
  available: { tone: 'success', icon: CheckCircle2 },
  missing: { tone: 'danger', icon: XCircle },
  qr_pending: { tone: 'warning', icon: Hourglass, live: true },
  error: { tone: 'danger', icon: XCircle },
  stopped: { tone: 'neutral', icon: CircleDashed },
  starting: { tone: 'info', icon: LoaderCircle, spin: true },
  stopping: { tone: 'warning', icon: LoaderCircle, spin: true },
  gateway_running: { tone: 'success', icon: CheckCircle2, live: true },
};

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

const LIVE_STATUSES = new Set<string>(['running', 'waiting_for_input', 'queued', 'paused', 'starting', 'stopping', 'stop_requested', 'pending', 'qr_pending', 'cancelling', 'reserved', 'waiting_for_recovery']);

/** Whether a status represents work that is still in progress (not settled). */
function isLiveStatus(status: string | null | undefined): boolean {
  return Boolean(status && LIVE_STATUSES.has(status));
}

/** Maps domain-specific statuses onto the shared presentation keys. */
function toStatusKey(status: string): StatusKey {
  if (status === 'succeeded') return 'completed';
  if (status === 'timed_out') return 'failed';
  if (status === 'cancelling') return 'stopping';
  if (status === 'stop_requested') return 'stopping';
  if (status === 'waiting_for_recovery') return 'waiting_for_input';
  if (status === 'uncertain') return 'paused';
  if (status === 'reserved') return 'queued';
  if (status in STATUS_CONFIG) return status as StatusKey;
  return 'idle';
}

/**
 * A compact status mark without a label: a breathing dot for live work and a still
 * icon for settled work. Use it where a label already sits nearby (list rows, nodes).
 */
function StatusDot({ status, label, className }: { status: StatusKey; label?: string; className?: string }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const tone = TONE_TEXT[config.tone];
  return (
    <span className={cn('inline-flex size-4 shrink-0 items-center justify-center', tone, className)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {config.live
        ? <span className={cn('wl-live', status === 'waiting_for_input' || status === 'qr_pending' ? 'wl-breathe' : undefined)} />
        : <Icon className={cn('size-4', config.spin && 'motion-safe:animate-spin', config.pop && 'wl-check-pop')} strokeWidth={2.25} />}
    </span>
  );
}

type StatusBadgeProps = {
  status: StatusKey;
  /** Overrides the shared label when a surface needs more specific wording. */
  label?: string;
  className?: string;
};

function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const { t } = useTranslation('common');
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Badge variant={config.tone} className={cn('tabular-nums', config.live && config.tone === 'brand' && 'wl-live-glow', className)}>
      {config.live
        ? <span className={cn('wl-live !size-1.5', status === 'waiting_for_input' || status === 'qr_pending' ? 'wl-breathe' : undefined)} aria-hidden="true" />
        : <Icon className={cn('size-3.5', config.spin && 'motion-safe:animate-spin', config.pop && 'wl-check-pop')} aria-hidden="true" />}
      <span>{label ?? t(`status.${status}`)}</span>
    </Badge>
  );
}

export { isLiveStatus, StatusBadge, StatusDot, toStatusKey };
export type { StatusKey, StatusTone };
