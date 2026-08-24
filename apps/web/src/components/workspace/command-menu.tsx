import { useNavigate, useParams } from '@tanstack/react-router';
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
import { agents, artifacts, runs, workflows } from '@/mock/data';

function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const { teamSlug } = useParams({ strict: false });
  const slug = teamSlug ?? 'acme';

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
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/home', params: { teamSlug: slug } }))}>
            <Home className="size-4" /> {t('nav.home')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/agents', params: { teamSlug: slug } }))}>
            <Bot className="size-4" /> {t('nav.agents')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/workflows', params: { teamSlug: slug } }))}>
            <Workflow className="size-4" /> {t('nav.workflows')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/runs', params: { teamSlug: slug } }))}>
            <Play className="size-4" /> {t('nav.runs')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/artifacts', params: { teamSlug: slug } }))}>
            <FileStack className="size-4" /> {t('nav.artifacts')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/mcp-servers', params: { teamSlug: slug } }))}>
            <Server className="size-4" /> {t('nav.mcpServers')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('command.create')}>
          <CommandItem
            onSelect={() => closeAndGo(() => void navigate({
              to: '/$teamSlug/home',
              params: { teamSlug: slug },
              search: { assistant: 'open' },
            }))}
          >
            <MessageSquareText className="size-4" /> {t('command.openAssistant')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/agents/$agentId', params: { teamSlug: slug, agentId: 'new' } }))}>
            <Plus className="size-4" /> {t('command.createAgent')}
          </CommandItem>
          <CommandItem onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/workflows/$workflowId', params: { teamSlug: slug, workflowId: 'new' } }))}>
            <Plus className="size-4" /> {t('command.createWorkflow')}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t('command.recent')}>
          {workflows
            .filter((item) => item.teamSlug === slug)
            .slice(0, 3)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/workflows/$workflowId', params: { teamSlug: slug, workflowId: item.id } }))}
              >
                <Workflow className="size-4" /> {item.name}
              </CommandItem>
            ))}
          {agents
            .filter((item) => item.teamSlug === slug)
            .slice(0, 2)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/agents/$agentId', params: { teamSlug: slug, agentId: item.id } }))}
              >
                <Bot className="size-4" /> {item.name}
              </CommandItem>
            ))}
          {runs
            .filter((item) => item.teamSlug === slug)
            .slice(0, 2)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/runs/$runId', params: { teamSlug: slug, runId: item.id } }))}
              >
                <Play className="size-4" /> {item.workflowName}
              </CommandItem>
            ))}
          {artifacts
            .filter((item) => item.teamSlug === slug)
            .slice(0, 1)
            .map((item) => (
              <CommandItem
                key={item.id}
                onSelect={() => closeAndGo(() => void navigate({ to: '/$teamSlug/artifacts/$artifactId', params: { teamSlug: slug, artifactId: item.id } }))}
              >
                <FileStack className="size-4" /> {item.name}
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export { CommandMenu };
