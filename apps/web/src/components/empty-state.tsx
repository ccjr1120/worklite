import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type EmptyStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  children?: ReactNode;
};

function EmptyState({ title, description, actionLabel, onAction, className, children }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-start gap-3 rounded-lg border border-dashed border-border bg-surface px-6 py-10', className)}>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-xl text-[13px] text-muted-foreground">{description}</p>
      {actionLabel && onAction ? (
        <Button onClick={onAction}>{actionLabel}</Button>
      ) : null}
      {children}
    </div>
  );
}

export { EmptyState };
