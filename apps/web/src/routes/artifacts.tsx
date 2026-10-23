import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { ArtifactListPane } from '@/features/artifacts/artifact-list-pane';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/artifacts')({
  component: ArtifactsLayout,
});

function ArtifactsLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const detailSelected = pathname.startsWith('/artifacts/');
  const activeArtifactId = detailSelected ? decodeURIComponent(pathname.slice('/artifacts/'.length)) : null;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className={cn('h-full min-h-0 w-full shrink-0 md:w-[340px] lg:w-[380px]', detailSelected ? 'hidden md:block' : 'block')}>
        <ArtifactListPane activeArtifactId={activeArtifactId} />
      </div>
      <div className={cn('h-full min-h-0 min-w-0 flex-1 overflow-y-auto', detailSelected ? 'block' : 'hidden md:block')}>
        <Outlet />
      </div>
    </div>
  );
}
