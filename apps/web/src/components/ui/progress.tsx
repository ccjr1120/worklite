import * as ProgressPrimitive from '@radix-ui/react-progress';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Progress({ className, value, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle', className)} {...props}>
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-brand transition-transform duration-[180ms] ease-out"
        style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
