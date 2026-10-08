import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('wl-shimmer rounded-sm', className)} {...props} />;
}

export { Skeleton };
