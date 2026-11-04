import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { focusRing } from '@/components/ui/interaction';

// `wl-press` gives every variant the shared press-and-spring-back feedback.
const buttonVariants = cva(
  `wl-press inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ${focusRing}`,
  {
    variants: {
      variant: {
        primary:
          'wl-primary bg-brand text-brand-foreground hover:bg-brand-hover active:bg-brand-active disabled:hover:bg-brand',
        secondary:
          'border border-border bg-surface text-foreground hover:border-foreground/15 hover:bg-surface-subtle active:bg-border disabled:hover:border-border disabled:hover:bg-surface',
        ghost: 'text-foreground hover:bg-surface-subtle active:bg-border disabled:hover:bg-transparent',
        destructive: 'bg-danger text-danger-foreground shadow-xs hover:bg-danger/90 active:bg-danger/80 disabled:hover:bg-danger',
        link: 'h-auto px-0 text-brand-text underline-offset-4 hover:underline disabled:hover:no-underline',
      },
      size: {
        default: 'h-[38px] min-w-9 px-4',
        compact: 'h-8 min-w-8 px-3 text-[13px]',
        sm: 'h-7 min-w-7 rounded-sm px-2.5 text-[13px]',
        icon: 'size-[38px]',
        'icon-compact': 'size-8',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, title, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const accessibleLabel = props['aria-label'];
  const resolvedTitle = title ?? (
    (size === 'icon' || size === 'icon-compact') && typeof accessibleLabel === 'string'
      ? accessibleLabel
      : undefined
  );

  return <Comp className={cn(buttonVariants({ variant, size, className }))} title={resolvedTitle} {...props} />;
}

export { Button, buttonVariants };
