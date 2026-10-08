import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type PageHeadingProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Optional status or meta shown beside the title. */
  meta?: ReactNode;
  className?: string;
};

function PageHeading({ title, description, actions, meta, className }: PageHeadingProps) {
  return (
    <div className={cn('wl-enter flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h1 className="truncate text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
          {meta}
        </div>
        {description ? <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Shared page container: one padding and max-width scale for every page family. */
function PageContainer({ width = 'collection', className, children }: { width?: 'collection' | 'detail' | 'form' | 'full'; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-7 px-4 py-6 md:px-6 md:py-8',
        width === 'collection' && 'max-w-[1440px]',
        width === 'detail' && 'max-w-[1200px]',
        width === 'form' && 'max-w-[840px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export { PageContainer, PageHeading };
