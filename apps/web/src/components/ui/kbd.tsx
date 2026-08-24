import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-surface-subtle px-1 font-mono text-[11px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
