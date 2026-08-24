import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-subtle text-muted-foreground',
        brand: 'border-transparent bg-brand-subtle text-brand',
        success: 'border-transparent bg-success-subtle text-success',
        warning: 'border-transparent bg-warning-subtle text-warning',
        danger: 'border-transparent bg-danger-subtle text-danger',
        info: 'border-transparent bg-info-subtle text-info',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
