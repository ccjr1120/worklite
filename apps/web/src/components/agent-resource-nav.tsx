import { Link } from '@tanstack/react-router';
import { Blocks, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TabNav, tabTriggerClassName } from '@/components/ui/tabs';

type AgentResourceView = 'skills' | 'mcp-servers';

// Capability destinations share the page-level underline tab grammar.
function AgentResourceNav({ active }: { active: AgentResourceView }) {
  const { t } = useTranslation('workspace');
  const items = [
    { id: 'skills', label: t('nav.skills'), to: '/skills', icon: Blocks },
    { id: 'mcp-servers', label: t('nav.mcpServers'), to: '/mcp-servers', icon: Server },
  ] as const;

  return (
    <TabNav className="mt-6" aria-label={t('nav.capabilities')}>
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          className={tabTriggerClassName()}
          aria-current={active === item.id ? 'page' : undefined}
        >
          <item.icon aria-hidden="true" />
          {item.label}
        </Link>
      ))}
    </TabNav>
  );
}

export { AgentResourceNav };
