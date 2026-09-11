import { Ban, CheckCircle2, CircleDashed, LoaderCircle, PauseCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type RunUiStatus = 'queued' | 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';

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

const STATUS_CONFIG: Record<
  StatusKey,
  { variant: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'; icon: typeof CheckCircle2 }
> = {
  queued: { variant: 'neutral', icon: CircleDashed },
  running: { variant: 'brand', icon: LoaderCircle },
  waiting_for_input: { variant: 'warning', icon: PauseCircle },
  completed: { variant: 'success', icon: CheckCircle2 },
  failed: { variant: 'danger', icon: XCircle },
  cancelled: { variant: 'neutral', icon: Ban },
  idle: { variant: 'neutral', icon: CircleDashed },
  draft: { variant: 'warning', icon: CircleDashed },
  published: { variant: 'success', icon: CheckCircle2 },
  connected: { variant: 'success', icon: CheckCircle2 },
  disabled: { variant: 'neutral', icon: Ban },
  disconnected: { variant: 'neutral', icon: CircleDashed },
  unreachable: { variant: 'danger', icon: XCircle },
  auth_failed: { variant: 'danger', icon: XCircle },
  unconfigured: { variant: 'neutral', icon: CircleDashed },
  valid: { variant: 'success', icon: CheckCircle2 },
  invalid: { variant: 'danger', icon: XCircle },
  pending: { variant: 'info', icon: LoaderCircle },
  available: { variant: 'success', icon: CheckCircle2 },
  missing: { variant: 'danger', icon: XCircle },
  qr_pending: { variant: 'warning', icon: LoaderCircle },
  error: { variant: 'danger', icon: XCircle },
  stopped: { variant: 'neutral', icon: CircleDashed },
  starting: { variant: 'info', icon: LoaderCircle },
  stopping: { variant: 'warning', icon: LoaderCircle },
  gateway_running: { variant: 'success', icon: CheckCircle2 },
};

type StatusBadgeProps = {
  status: StatusKey;
  className?: string;
};

function StatusBadge({ status, className }: StatusBadgeProps) {
  const { t } = useTranslation('common');
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const spinning = status === 'running' || status === 'pending' || status === 'qr_pending' || status === 'starting' || status === 'stopping';

  return (
    <Badge variant={config.variant} className={cn('tabular-nums', className)}>
      <Icon className={cn('size-3', spinning && 'motion-safe:animate-spin')} aria-hidden="true" />
      <span>{t(`status.${status}`)}</span>
    </Badge>
  );
}

export { StatusBadge };
