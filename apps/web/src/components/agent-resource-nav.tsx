import { Link } from '@tanstack/react-router';
import { Blocks, Bot, KeyRound, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';

type AgentResourceView = 'agents' | 'skills' | 'mcp-servers' | 'providers';

function AgentResourceNav({ active }: { workspaceSlug?: string; active: AgentResourceView }) {
  const { t } = useTranslation('workspace');
  const items = [
    { id: 'agents', label: t('nav.agents'), to: '/agents', icon: Bot },
    { id: 'skills', label: t('nav.skills'), to: '/skills', icon: Blocks },
    { id: 'mcp-servers', label: t('nav.mcpServers'), to: '/mcp-servers', icon: Server },
    { id: 'providers', label: t('nav.modelProviders'), to: '/model-providers', icon: KeyRound },
  ] as const;

  return (
    <nav className="mt-6 flex h-9 w-fit items-center gap-1 rounded-md bg-surface-subtle p-1" aria-label={t('nav.agentResources')}>
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-sm px-3 text-[13px] font-medium text-muted-foreground hover:bg-surface/70 hover:text-foreground',
            surfaceInteraction,
            focusRingInset,
            active === item.id && 'bg-surface text-foreground shadow-sm',
          )}
          aria-current={active === item.id ? 'page' : undefined}
        >
          <item.icon className="size-4" aria-hidden="true" />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export { AgentResourceNav };
