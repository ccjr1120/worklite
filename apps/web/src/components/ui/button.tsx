import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,color,box-shadow,border-color,opacity] duration-[120ms] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-foreground hover:bg-brand-hover active:bg-brand-active',
        secondary:
          'border border-border bg-surface text-foreground hover:bg-surface-subtle',
        ghost: 'text-foreground hover:bg-surface-subtle',
        destructive: 'bg-danger text-white hover:bg-danger/90',
        link: 'text-brand underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 min-w-8 px-3.5',
        compact: 'h-8 min-w-8 px-2.5 text-[13px]',
        sm: 'h-7 min-w-7 px-2 text-[13px]',
        icon: 'h-9 w-9',
        'icon-compact': 'h-8 w-8',
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

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
export type { ButtonProps };
