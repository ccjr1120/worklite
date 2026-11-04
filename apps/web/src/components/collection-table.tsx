import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

function CollectionTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('wl-collection overflow-hidden rounded-xl border border-border bg-surface shadow-xs', className)}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function CollectionHeader({ columns, className }: { columns: string[]; className?: string }) {
  return (
    <div className={cn('hidden grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 border-b border-border bg-surface-subtle/30 px-4 py-2.5 text-xs font-medium text-muted-foreground md:grid', className)}>
      {columns.map((column) => (
        <span key={column} className="truncate">{column}</span>
      ))}
    </div>
  );
}

// Secondary row actions marked with `data-row-action` fade in on hover and focus.
function CollectionRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'group/row grid grid-cols-1 items-center gap-2 border-b border-border/70 px-4 py-3.5 transition-colors duration-[140ms] last:border-b-0 hover:bg-surface-subtle/70 focus-within:bg-surface-subtle/70 md:min-h-[52px] md:grid-cols-[2fr_1fr_1fr_1fr_1fr] md:gap-3 md:py-2.5 [&_[data-row-action]]:transition-opacity [&_[data-row-action]]:duration-[140ms] md:[&_[data-row-action]]:opacity-0 md:hover:[&_[data-row-action]]:opacity-100 md:focus-within:[&_[data-row-action]]:opacity-100',
        className,
      )}
    >
      {children}
    </div>
  );
}

export { CollectionHeader, CollectionRow, CollectionTable };
