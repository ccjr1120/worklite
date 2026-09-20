import { Link } from '@tanstack/react-router';
import { Blocks, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { focusRingInset, surfaceInteraction } from '@/components/ui/interaction';
import { cn } from '@/lib/utils';

type AgentResourceView = 'skills' | 'mcp-servers';

function AgentResourceNav({ active }: { active: AgentResourceView }) {
  const { t } = useTranslation('workspace');
  const items = [
    { id: 'skills', label: t('nav.skills'), to: '/skills', icon: Blocks },
    { id: 'mcp-servers', label: t('nav.mcpServers'), to: '/mcp-servers', icon: Server },
  ] as const;

  return (
    <nav className="mt-6 flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-surface-subtle p-1" aria-label={t('nav.capabilities')}>
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-3 text-[13px] font-medium text-muted-foreground hover:bg-surface/70 hover:text-foreground',
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
