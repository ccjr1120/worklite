import { useNavigate } from '@tanstack/react-router';
import { Blocks, FileText, KeyRound, MessageSquareText, Plus, Puzzle, ScrollText, Server, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useAgentsQuery } from '@/api/queries';

function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const { data: directory = [] } = useAgentsQuery();
  const agents = directory.filter((agent) => agent.kind === 'custom');

  function closeAndGo(run: () => void) {
    onOpenChange(false);
    run();
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t('command.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('command.empty')}</CommandEmpty>
        <CommandGroup heading={t('command.navigation')}>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/chat' }))}><MessageSquareText className="size-4" />{t('nav.chat')}</CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/agents' }))}>
            <Bot className="size-4" /> {t('nav.agents')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/model-providers' }))}>
            <KeyRound className="size-4" /> {t('nav.modelProviders')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/logs', search: { tab: 'statistics', range: '24h' } }))}>
            <ScrollText className="size-4" /> {t('nav.logs')}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t('nav.resourceManagement')}>
          <CommandItem value="plugins" keywords={[t('nav.plugins')]} onSelect={() => closeAndGo(() => void navigate({ to: '/plugins' }))}>
            <Puzzle className="size-4" /> {t('nav.plugins')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/skills' }))}>
            <Blocks className="size-4" /> {t('nav.skills')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/mcp-servers' }))}>
            <Server className="size-4" /> {t('nav.mcpServers')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/artifacts' }))}>
            <FileText className="size-4" /> {t('nav.artifacts')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('command.create')}>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/agents/$agentId', params: { agentId: 'new' } }))}>
            <Plus className="size-4" /> {t('command.createAgent')}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t('nav.agents')}>
          {agents
            .map((item) => (
              <CommandItem
                key={item.id}
                value={`agent:${item.id}`}
                keywords={[item.name, item.responsibility ?? '']}
                onSelect={() => closeAndGo(() => void navigate({ to: '/agents/$agentId', params: { agentId: item.id } }))}
              >
                <Bot className="size-4" /> {item.name}
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export { CommandMenu };
