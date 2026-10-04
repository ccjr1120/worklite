import { useNavigate } from '@tanstack/react-router';
import { Home, KeyRound, MessageSquareText, Plus, Puzzle, ScrollText, UsersRound, Workflow } from 'lucide-react';
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
import { useWorkflowsQuery } from '@/api/queries';

function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const { data: workflows = [] } = useWorkflowsQuery();

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
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/home' }))}>
            <Home className="size-4" /> {t('nav.home')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/workflows' }))}>
            <Workflow className="size-4" /> {t('nav.workflows')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/plugins' }))}>
            <Puzzle className="size-4" /> {t('nav.plugins')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/agent-teams/$teamId', params: { teamId: 'agent_team_bmad_tea' } }))}>
            <UsersRound className="size-4" /> {t('nav.agentTeam')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/model-providers', search: { tab: 'providers' } }))}>
            <KeyRound className="size-4" /> {t('nav.modelProviders')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/logs', search: { tab: 'statistics', range: '24h' } }))}>
            <ScrollText className="size-4" /> {t('nav.logs')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('command.create')}>
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
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export { CommandMenu };
