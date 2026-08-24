import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkLiteMark } from '@/components/worklite-mark';

type AuthShellProps = {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

function AuthShell({ title, description, children, footer, onSubmit }: AuthShellProps) {
  const { t } = useTranslation('common');

  return (
    <div className="flex min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-[400px] flex-col justify-center px-5 py-10 sm:px-0">
        <div className="mb-8 flex items-center gap-2">
          <WorkLiteMark />
          <span className="text-sm font-semibold">{t('brand.name')}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">{description}</p>
        <form className="mt-8 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          {children}
        </form>
        {footer ? <div className="mt-6 text-[13px] text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  );
}

export { AuthShell };
