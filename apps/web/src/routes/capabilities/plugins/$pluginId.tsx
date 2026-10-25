import { createFileRoute, notFound } from '@tanstack/react-router';
import { PluginConfiguration } from '@/features/plugins/plugin-configuration';

export const Route = createFileRoute('/capabilities/plugins/$pluginId')({
  beforeLoad: ({ params }) => { if (params.pluginId === 'feishu-bot' || params.pluginId === 'wechat-bot') throw notFound(); },
  component: PluginConfigPage,
});

function PluginConfigPage() {
  const { pluginId } = Route.useParams();
  return <PluginConfiguration pluginId={pluginId} />;
}
