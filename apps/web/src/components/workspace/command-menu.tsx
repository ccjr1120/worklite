import { useNavigate } from '@tanstack/react-router';
import { Bot, FileStack, Home, MessageSquareText, Play, Plus, Server, Workflow } from 'lucide-react';
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
import { useAgentsQuery, useRunsQuery, useWorkflowsQuery } from '@/api/queries';

function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const { data: workflows = [] } = useWorkflowsQuery();
  const { data: agents = [] } = useAgentsQuery();
  const { data: runs = [] } = useRunsQuery();

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
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/home' }))}>
            <Home className="size-4" /> {t('nav.home')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/agents' }))}>
            <Bot className="size-4" /> {t('nav.agents')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/workflows' }))}>
            <Workflow className="size-4" /> {t('nav.workflows')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/runs' }))}>
            <Play className="size-4" /> {t('nav.runs')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/artifacts' }))}>
            <FileStack className="size-4" /> {t('nav.artifacts')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/mcp-servers' }))}>
            <Server className="size-4" /> {t('nav.mcpServers')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('command.create')}>
          <CommandItem
            onSelect={() => closeAndGo(() => void navigate({
              to: '/home',
              search: { assistant: 'open' },
            }))}
          >
            <MessageSquareText className="size-4" /> {t('command.openAssistant')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/agents/$agentId', params: { agentId: 'new' } }))}>
            <Plus className="size-4" /> {t('command.createAgent')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/workflows/$workflowId', params: { workflowId: 'new' } }))}>
            <Plus className="size-4" /> {t('command.createWorkflow')}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t('command.recent')}>
          {workflows
            .slice(0, 3)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/workflows/$workflowId', params: { workflowId: item.id } }))}
              >
                <Workflow className="size-4" /> {item.name}
              </CommandItem>
            ))}
          {agents
            .slice(0, 2)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/agents/$agentId', params: { agentId: item.id } }))}
              >
                <Bot className="size-4" /> {item.name}
              </CommandItem>
            ))}
          {runs
            .slice(0, 2)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/runs/$runId', params: { runId: item.id } }))}
              >
                <Play className="size-4" /> {item.workflowName}
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export { CommandMenu };
