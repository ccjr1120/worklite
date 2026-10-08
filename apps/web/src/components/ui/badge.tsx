import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// Badges never wrap: a long label truncates inside the pill instead of breaking lines.
const badgeVariants = cva(
  'inline-flex h-6 min-w-0 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium transition-[background-color,color,border-color] duration-[200ms] ease-[var(--ease-out)] [&>span]:truncate [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-subtle text-muted-foreground',
        brand: 'border-transparent bg-brand-subtle text-brand-text',
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

export { Badge };
