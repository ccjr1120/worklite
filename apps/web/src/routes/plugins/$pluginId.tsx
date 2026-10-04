import { createFileRoute, notFound } from '@tanstack/react-router';
import { PluginConfiguration } from '@/features/plugins/plugin-configuration';

export const Route = createFileRoute('/plugins/$pluginId')({
  beforeLoad: ({ params }) => { if (params.pluginId === 'feishu-bot') throw notFound(); },
  component: PluginConfigPage,
});

function PluginConfigPage() {
  const { pluginId } = Route.useParams();
  return <PluginConfiguration pluginId={pluginId} />;
}
