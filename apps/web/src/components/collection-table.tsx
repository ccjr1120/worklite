import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

function CollectionTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function CollectionHeader({ columns, className }: { columns: string[]; className?: string }) {
  return (
    <div className={cn('hidden grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground md:grid', className)}>
      {columns.map((column) => (
        <span key={column}>{column}</span>
      ))}
    </div>
  );
}

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
        'grid grid-cols-1 items-center gap-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface-subtle md:grid-cols-[2fr_1fr_1fr_1fr_1fr] md:gap-3 md:py-[10px]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export { CollectionHeader, CollectionRow, CollectionTable };
