import { ArrowUp, Download, History, LoaderCircle, Play, Plus, Square, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowView } from '@worklite/contracts';
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command';
import { focusRingInset } from '@/components/ui/interaction';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type SlashCommand = '/log' | '/new' | '/resume';

const SLASH_COMMANDS: Array<{ value: SlashCommand; icon: typeof Download; descriptionKey: 'commands.logDescription' | 'commands.newDescription' | 'commands.resumeDescription' }> = [
  { value: '/log', icon: Download, descriptionKey: 'commands.logDescription' },
  { value: '/new', icon: Plus, descriptionKey: 'commands.newDescription' },
  { value: '/resume', icon: History, descriptionKey: 'commands.resumeDescription' },
];

type ComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  selectedWorkflow: WorkflowView | null;
  onRemoveWorkflow: () => void;
  commandMatches: Array<{ value: SlashCommand; icon: typeof Download; descriptionKey: 'commands.logDescription' | 'commands.newDescription' | 'commands.resumeDescription' }>;
  commandMenuOpen: boolean;
  onRunCommand: (command: SlashCommand) => void;
  mentionMatches: WorkflowView[];
  mentionMenuOpen: boolean;
  onSelectMention: (workflow: WorkflowView) => void;
  activeValue: string;
  onActiveValueChange: (value: string) => void;
  onDismissMenus: () => void;
  running: boolean;
  busy: boolean;
  submitDisabled: boolean;
  waitingForInput: boolean;
  onStop: () => void;
};

// Both menus reuse the shared cmdk primitive so option roles, active-option tracking,
// and scroll-into-view have one implementation. cmdk does not own an input here:
// filtering follows the composer text and keyboard focus never leaves the textarea.
function Composer({
  draft, onDraftChange, onSubmit, onKeyDown, onFocus,
  selectedWorkflow, onRemoveWorkflow,
  commandMatches, commandMenuOpen, onRunCommand,
  mentionMatches, mentionMenuOpen, onSelectMention,
  activeValue, onActiveValueChange, onDismissMenus,
  running, busy, submitDisabled, waitingForInput, onStop,
}: ComposerProps) {
  const { t } = useTranslation('assistant');
  const menuOpen = commandMenuOpen || mentionMenuOpen;

  return (
    <PromptInput onSubmit={onSubmit}>
      <label htmlFor="assistant-message" className="sr-only">{t('composer.label')}</label>
      <Popover open={menuOpen} onOpenChange={(next) => { if (!next) onDismissMenus(); }}>
        <PopoverAnchor asChild>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-surface px-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
            {selectedWorkflow ? (
              <span className="inline-flex h-7 max-w-[min(16rem,70%)] shrink-0 items-center gap-1.5 rounded-md border border-brand/30 bg-brand-subtle px-2 text-[13px] font-medium text-foreground">
                <Play className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
                <span className="truncate">{selectedWorkflow.name}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className={cn('rounded-sm text-muted-foreground hover:text-foreground', focusRingInset)} aria-label={t('mentions.remove')} onClick={onRemoveWorkflow}>
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('mentions.remove')}</TooltipContent>
                </Tooltip>
              </span>
            ) : null}
            <PromptInputTextarea
              className="min-w-32 basis-40 border-0 bg-transparent px-1 focus:border-transparent focus:ring-0"
              id="assistant-message"
              name="chat-bot-message"
              autoComplete="off"
              value={draft}
              onValueChange={onDraftChange}
              onFocus={onFocus}
              onKeyDown={onKeyDown}
              placeholder={waitingForInput ? t('composer.answerPlaceholder') : t('composer.placeholder')}
              role="combobox"
              aria-expanded={menuOpen}
              rows={1}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(420px,calc(100vw-24px))] p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <Command shouldFilter={false} value={activeValue} onValueChange={onActiveValueChange} className="bg-transparent">
            <CommandList className="max-h-64" aria-label={mentionMenuOpen ? t('mentions.menuLabel') : t('commands.menuLabel')}>
              {mentionMenuOpen ? (
                <>
                  <CommandEmpty>{t('mentions.empty')}</CommandEmpty>
                  {mentionMatches.map((workflow) => (
                    <CommandItem key={workflow.id} value={`mention:${workflow.id}`} onSelect={() => onSelectMention(workflow)}>
                      <Play className="size-4 shrink-0 text-brand" aria-hidden="true" />
                      <span className="truncate">{workflow.name}</span>
                    </CommandItem>
                  ))}
                </>
              ) : (
                <>
                  <CommandEmpty>{t('commands.empty')}</CommandEmpty>
                  {commandMatches.map((command) => {
                    const Icon = command.icon;
                    return (
                      <CommandItem key={command.value} value={command.value} onSelect={() => onRunCommand(command.value)} className="items-start">
                        <Icon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
                        <span>
                          <span className="block font-mono text-[13px] font-medium">{command.value}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{t(command.descriptionKey)}</span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PromptInputSubmit
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md bg-brand text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
            status={running ? 'streaming' : busy ? 'submitted' : 'idle'}
            aria-label={running ? t('composer.stop') : t('composer.send')}
            disabled={submitDisabled}
            onStop={onStop}
          >
            {running ? <Square className="size-3.5 fill-current" aria-hidden="true" /> : busy ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <ArrowUp className="size-4" aria-hidden="true" />}
          </PromptInputSubmit>
        </TooltipTrigger>
        <TooltipContent>{running ? t('composer.stop') : t('composer.send')}</TooltipContent>
      </Tooltip>
    </PromptInput>
  );
}

export { Composer, SLASH_COMMANDS };
export type { SlashCommand };
