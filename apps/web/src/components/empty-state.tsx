import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type EmptyStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: LucideIcon;
  className?: string;
  children?: ReactNode;
};

function EmptyState({ title, description, actionLabel, onAction, icon: Icon = Inbox, className, children }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl bg-surface-subtle/40 px-6 py-10 text-center', className)}>
      <span className="flex size-9 items-center justify-center text-muted-foreground" aria-hidden="true">
        <Icon className="size-5" />
      </span>
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-md text-[13px] leading-5 text-muted-foreground">{description}</p>
      {actionLabel && onAction ? (
        <Button className="mt-1" onClick={onAction}>{actionLabel}</Button>
      ) : null}
      {children}
    </div>
  );
}

export { EmptyState };
