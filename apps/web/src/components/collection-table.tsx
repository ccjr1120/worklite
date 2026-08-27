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
    <div className={cn('grid min-w-[720px] grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground', className)}>
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
        'grid min-w-[720px] grid-cols-[2fr_1fr_1fr_1fr_1fr] items-center gap-3 border-b border-border px-4 py-[10px] last:border-b-0 hover:bg-surface-subtle',
        className,
      )}
    >
      {children}
    </div>
  );
}

export { CollectionHeader, CollectionRow, CollectionTable };
