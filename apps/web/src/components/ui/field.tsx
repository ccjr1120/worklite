import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type FieldProps = {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
};

function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-2', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-[13px] text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {describedBy ? <span className="sr-only">{describedBy}</span> : null}
    </div>
  );
}

export { Field };
export type { FieldProps };
