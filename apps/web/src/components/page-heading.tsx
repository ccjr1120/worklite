import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type PageHeadingProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
};

function PageHeading({ title, description, actions, className }: PageHeadingProps) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export { PageHeading };
