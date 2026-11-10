import { Link } from '@tanstack/react-router';
import { ArrowUp, Download, History, LoaderCircle, Play, Plus, Sparkles, Square, X } from 'lucide-react';
import { type ClipboardEvent as ReactClipboardEvent, type CompositionEvent as ReactCompositionEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatAttachmentView, AgentView } from '@worklite/contracts';
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command';
import { focusRingInset } from '@/components/ui/interaction';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type SlashCommand = '/log' | '/new' | '/resume' | '/summarize';

const SLASH_COMMANDS: Array<{ value: SlashCommand; icon: typeof Download; descriptionKey: 'commands.logDescription' | 'commands.newDescription' | 'commands.resumeDescription' | 'commands.summarizeDescription' }> = [
  { value: '/log', icon: Download, descriptionKey: 'commands.logDescription' },
  { value: '/new', icon: Plus, descriptionKey: 'commands.newDescription' },
  { value: '/resume', icon: History, descriptionKey: 'commands.resumeDescription' },
  { value: '/summarize', icon: Sparkles, descriptionKey: 'commands.summarizeDescription' },
];

type ComposerProps = {
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  switcher: ReactNode;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: (event: ReactCompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEnd: (event: ReactCompositionEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  selectedAgent: (AgentView & { continuation?: { executionId: string; runId: string } }) | null;
  onRemoveAgent: () => void;
  attachments: ChatAttachmentView[];
  attachmentsUploading: number;
  attachmentError: string;
  onPasteImages: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  commandMatches: Array<{ value: SlashCommand; icon: typeof Download; descriptionKey: 'commands.logDescription' | 'commands.newDescription' | 'commands.resumeDescription' | 'commands.summarizeDescription' }>;
  commandMenuOpen: boolean;
  onRunCommand: (command: SlashCommand) => void;
  mentionMatches: AgentView[];
  mentionMenuOpen: boolean;
  onSelectMention: (workflow: AgentView) => void;
  activeValue: string;
  onActiveValueChange: (value: string) => void;
  onDismissMenus: () => void;
  running: boolean;
  busy: boolean;
  canCancel: boolean;
  cancelling: boolean;
  submitDisabled: boolean;
  waitingForInput: boolean;
  suggestion?: string;
  onStop: () => void;
};

// Both menus reuse the shared cmdk primitive so option roles, active-option tracking,
// and scroll-into-view have one implementation. cmdk does not own an input here:
// filtering follows the composer text and keyboard focus never leaves the textarea.
function Composer({
  switcherOpen, onSwitcherOpenChange, switcher,
  draft, onDraftChange, onSubmit, onKeyDown, onCompositionStart, onCompositionEnd, onFocus,
  selectedAgent, onRemoveAgent,
  attachments, attachmentsUploading, attachmentError, onPasteImages, onRemoveAttachment,
  commandMatches, commandMenuOpen, onRunCommand,
  mentionMatches, mentionMenuOpen, onSelectMention,
  activeValue, onActiveValueChange, onDismissMenus,
  running, busy, canCancel, cancelling, submitDisabled, waitingForInput, suggestion, onStop,
}: ComposerProps) {
  const { t } = useTranslation('assistant');
  const menuOpen = switcherOpen || commandMenuOpen || mentionMenuOpen;

  // Ctrl/Cmd+V of a screenshot puts the image on the clipboard as a file. Text pasted alongside it
  // keeps the browser's own insertion, so only an image-only paste is taken over here.
  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    onPasteImages(images);
  }

  return (
    <PromptInput onSubmit={onSubmit} className="mx-auto max-w-3xl px-4 pb-4 pt-1 md:px-0">
      <label htmlFor="assistant-message" className="sr-only">{t('composer.label')}</label>
      <Popover open={menuOpen} onOpenChange={(next) => { if (!next) { onSwitcherOpenChange(false); onDismissMenus(); } }}>
        <PopoverAnchor asChild>
          {/* The composer is one floating card: mention token, auto-growing text, and submit share it. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-end gap-1.5 rounded-2xl border border-border bg-surface py-1.5 pl-2.5 pr-1.5 shadow-sm transition-[border-color,box-shadow] duration-[200ms] ease-[var(--ease-out)] focus-within:border-brand/60 focus-within:shadow-md focus-within:ring-[3px] focus-within:ring-ring/15">
            {attachments.length || attachmentsUploading ? (
              <ul className="wl-enter mb-1 flex w-full flex-wrap gap-2 px-1 pt-1" aria-label={t('attachment.listLabel')}>
                {attachments.map((attachment) => (
                  <li key={attachment.id} className="relative size-16 overflow-hidden rounded-lg border border-border bg-surface-subtle">
                    <img src={attachment.url} alt={attachment.fileName} className="size-full object-cover" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn('wl-press absolute right-0.5 top-0.5 rounded-full bg-background/85 p-0.5 text-muted-foreground shadow-xs hover:text-foreground', focusRingInset)}
                          aria-label={t('attachment.remove', { name: attachment.fileName })}
                          onClick={() => onRemoveAttachment(attachment.id)}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t('attachment.remove', { name: attachment.fileName })}</TooltipContent>
                    </Tooltip>
                  </li>
                ))}
                {Array.from({ length: attachmentsUploading }, (_value, index) => (
                  <li key={`uploading-${index}`} className="flex size-16 items-center justify-center rounded-lg border border-dashed border-border bg-surface-subtle" aria-label={t('attachment.uploading')}>
                    <LoaderCircle className="size-4 text-muted-foreground motion-safe:animate-spin" aria-hidden="true" />
                  </li>
                ))}
              </ul>
            ) : null}
            {selectedAgent ? (
              <span className="wl-enter mb-1.5 inline-flex h-7 max-w-[min(16rem,70%)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-brand/30 bg-brand-subtle pl-2.5 pr-1.5 text-[13px] font-medium text-foreground">
                <Play className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
                <Link to="/agents/$agentId" params={{ agentId: selectedAgent.id }} search={selectedAgent.continuation ? { runId: selectedAgent.continuation.runId } : undefined} className="truncate hover:underline" title={selectedAgent.name}>@{selectedAgent.name}{selectedAgent.continuation ? ` · ${t('mentions.continueInstance')}` : ''}</Link>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className={cn('wl-press rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground', focusRingInset)} aria-label={t('mentions.remove')} onClick={onRemoveAgent}>
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t('mentions.remove')}</TooltipContent>
                </Tooltip>
              </span>
            ) : null}
            <PromptInputTextarea
              className="min-w-32 basis-40 border-0 bg-transparent px-1 shadow-none focus:border-transparent focus:ring-0"
              id="assistant-message"
              name="chat-message"
              autoComplete="off"
              value={draft}
              onValueChange={onDraftChange}
              onFocus={onFocus}
              onPaste={handlePaste}
              onKeyDown={onKeyDown}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              placeholder={waitingForInput ? t('composer.answerPlaceholder') : suggestion ?? t('composer.placeholder')}
              role="combobox"
              aria-expanded={menuOpen}
              rows={1}
            />
            {canCancel && !running ? (
              <Button type="button" variant="secondary" size="compact" className="ml-auto rounded-full" disabled={cancelling} aria-busy={cancelling} onClick={onStop}>
                {cancelling ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
                {t(cancelling ? 'composer.cancelling' : 'composer.cancel')}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <PromptInputSubmit
                  className={cn(
                    'wl-press inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-40',
                    !(canCancel && !running) && 'ml-auto',
                    running ? 'bg-foreground text-background hover:bg-foreground/85' : 'bg-brand bg-[image:var(--brand-gradient)] text-brand-foreground shadow-xs hover:bg-brand-hover hover:bg-none',
                    focusRingInset,
                  )}
                  status={running ? 'streaming' : busy && !cancelling ? 'submitted' : 'idle'}
                  aria-label={running ? t(cancelling ? 'composer.cancelling' : 'composer.cancel') : t('composer.send')}
                  aria-busy={running ? cancelling : busy && !cancelling}
                  disabled={submitDisabled}
                  onStop={running ? onStop : undefined}
                >
                  {running && cancelling ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : running ? <Square className="size-3.5 fill-current" aria-hidden="true" /> : busy && !cancelling ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <ArrowUp className="size-4" aria-hidden="true" />}
                </PromptInputSubmit>
              </TooltipTrigger>
              <TooltipContent>{running ? t(cancelling ? 'composer.cancelling' : 'composer.cancel') : t('composer.send')}</TooltipContent>
            </Tooltip>
            {attachmentError ? <p role="alert" className="w-full px-1 pb-0.5 text-xs text-danger">{attachmentError}</p> : null}
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          avoidCollisions={false}
          align="start"
          matchTrigger
          className="p-0"
          onOpenAutoFocus={(event) => { if (!switcherOpen) event.preventDefault(); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); document.getElementById('assistant-message')?.focus(); }}
        >
          {switcherOpen ? <div role="dialog" aria-label={t('history.title')} className="flex h-[min(24rem,50dvh)] flex-col">{switcher}</div> : <Command shouldFilter={false} value={activeValue} onValueChange={onActiveValueChange} className="bg-transparent">
            <CommandList className="max-h-64" aria-label={mentionMenuOpen ? t('mentions.menuLabel') : t('commands.menuLabel')}>
              {mentionMenuOpen ? (
                <>
                  <CommandEmpty>{t('mentions.empty')}</CommandEmpty>
                  {mentionMatches.map((workflow) => (
                    <CommandItem key={workflow.id} value={`mention:${workflow.id}`} onSelect={() => onSelectMention(workflow)}>
                      <Play className="size-4 shrink-0 text-brand" aria-hidden="true" />
                      <span className="truncate" title={workflow.name}>{workflow.name}</span>
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
          </Command>}
        </PopoverContent>
      </Popover>
    </PromptInput>
  );
}

export { Composer, SLASH_COMMANDS };
export type { SlashCommand };
