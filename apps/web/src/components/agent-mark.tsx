import { cn } from '@/lib/utils';

function AgentMark({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-subtle font-mono text-[11px] font-medium text-foreground',
        className,
      )}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export { AgentMark };
