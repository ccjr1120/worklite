import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Composer } from './composer';

afterEach(cleanup);

it('lets a running conversation choose steering or follow-up and send without stopping', () => {
  const onMode = vi.fn();
  const onStop = vi.fn();
  const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
  render(<TooltipProvider><Composer
    switcherOpen={false} onSwitcherOpenChange={vi.fn()} switcher={null}
    draft="追加要求" onDraftChange={vi.fn()} onSubmit={onSubmit} onKeyDown={vi.fn()}
    onCompositionStart={vi.fn()} onCompositionEnd={vi.fn()} onFocus={vi.fn()}
    selectedAgent={null} onRemoveAgent={vi.fn()} attachments={[]} attachmentsUploading={0}
    attachmentError="" onPasteImages={vi.fn()} onRemoveAttachment={vi.fn()}
    commandMatches={[]} commandMenuOpen={false} onRunCommand={vi.fn()}
    mentionMatches={[]} mentionMenuOpen={false} onSelectMention={vi.fn()}
    activeValue="" onActiveValueChange={vi.fn()} onDismissMenus={vi.fn()}
    running busy={false} canCancel cancelling={false} submitDisabled={false}
    waitingForInput={false} onStop={onStop} messageMode="steering" onMessageModeChange={onMode}
  /></TooltipProvider>);
  fireEvent.change(screen.getByRole('combobox', { name: '运行中消息处理方式' }), { target: { value: 'follow_up' } });
  expect(onMode).toHaveBeenCalledWith('follow_up');
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onStop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消当前执行' }));
  expect(onStop).toHaveBeenCalledTimes(1);
});
