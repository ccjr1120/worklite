import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

const CRUMBS_ID = 'workspace-crumbs';
const STATUS_ID = 'workspace-status';
const ACTIONS_ID = 'workspace-actions';

export const workspaceSlots = {
  crumbs: CRUMBS_ID,
  status: STATUS_ID,
  actions: ACTIONS_ID,
};

type Crumb = { label: string; to?: string };

function WorkspaceChrome({
  crumbs,
  back,
  status,
  actions,
}: {
  crumbs: Crumb[];
  back?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation('workspace');
  const [targets, setTargets] = useState<{ crumbs: HTMLElement | null; status: HTMLElement | null; actions: HTMLElement | null }>({
    crumbs: null,
    status: null,
    actions: null,
  });

  useLayoutEffect(() => {
    setTargets({
      crumbs: document.getElementById(CRUMBS_ID),
      status: document.getElementById(STATUS_ID),
      actions: document.getElementById(ACTIONS_ID),
    });
  }, []);

  const crumbNode = (
    <div className="flex min-w-0 items-center gap-2">
      {back}
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px]" aria-label={t('breadcrumbs')}>
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
          {index > 0 ? <span className="text-muted-foreground" aria-hidden="true">/</span> : null}
          {crumb.to ? (
            <Link to={crumb.to as '/'} className={cn('truncate text-muted-foreground hover:text-foreground')}>
              {crumb.label}
            </Link>
          ) : (
            <span className="truncate font-medium text-foreground">{crumb.label}</span>
          )}
        </span>
      ))}
      </nav>
    </div>
  );

  return (
    <>
      {targets.crumbs ? createPortal(crumbNode, targets.crumbs) : null}
      {targets.status ? createPortal(status ?? null, targets.status) : null}
      {targets.actions ? createPortal(actions ?? null, targets.actions) : null}
    </>
  );
}

export { WorkspaceChrome };
export type { Crumb };
