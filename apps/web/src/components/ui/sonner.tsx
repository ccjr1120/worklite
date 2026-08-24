import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '@/components/theme-provider';

function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-surface-raised group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-md',
          description: 'group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
