import { createFileRoute } from '@tanstack/react-router';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';

export const Route = createFileRoute('/artifacts/')({
  component: ArtifactsIndexPage,
});

function ArtifactsIndexPage() {
  const { t } = useTranslation('artifacts');

  return (
    <div className="mx-auto flex h-full w-full max-w-[900px] flex-col px-4 py-6 md:px-8">
      <WorkspaceChrome crumbs={[{ label: t('title') }]} />
      <div className="flex flex-1 items-center justify-center py-8">
        <EmptyState icon={FileText} title={t('list.selectTitle')} description={t('list.selectDescription')} />
      </div>
    </div>
  );
}
