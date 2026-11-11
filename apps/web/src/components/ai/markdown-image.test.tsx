import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@/i18n/config';
import StreamingMarkdownView from './streaming-markdown-view';
import { MarkdownImage } from './markdown-image';

describe('MarkdownImage', () => {
  afterEach(cleanup);

  it('renders an attachment image with its description', () => {
    render(<MarkdownImage src="/api/chat/attachments/att_abc" alt="首页截图" />);
    const image = screen.getByRole('img', { name: '首页截图' });
    expect(image.tagName).toBe('IMG');
    expect(image.getAttribute('src')).toBe('/api/chat/attachments/att_abc');
  });

  it('opens the original image and restores focus when closed with Escape', async () => {
    render(<MarkdownImage src="/api/chat/attachments/att_abc" alt="首页截图" />);
    const trigger = screen.getByRole('button', { name: '放大查看图片：首页截图' });
    trigger.focus();
    fireEvent.click(screen.getByRole('img', { name: '首页截图' }));
    const dialog = screen.getByRole('dialog', { name: '首页截图' });
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/api/chat/attachments/att_abc');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it.each(['Enter', ' '])('opens the preview with the %s key', (key) => {
    render(<MarkdownImage src="/image.png" alt="截图" />);
    fireEvent.keyDown(screen.getByRole('button'), { key });
    expect(screen.getByRole('dialog', { name: '截图' })).toBeTruthy();
  });

  it('closes with the close button and by clicking outside', async () => {
    render(<MarkdownImage src="/api/artifacts/art_one/content" alt="截图" />);
    const trigger = screen.getByRole('button', { name: '放大查看图片：截图' });
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(trigger);
    // Radix registers the outside pointer listener after the opening event.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removes a failed preview and keeps the expired placeholder', () => {
    render(<MarkdownImage src="/api/chat/attachments/att_abc" alt="首页截图" />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.error(within(screen.getByRole('dialog')).getByRole('img'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('图片已过期')).toBeTruthy();
  });

  it('does not keep an old preview open when the image source changes', () => {
    const { rerender } = render(<MarkdownImage src="/one.png" />);
    fireEvent.click(screen.getByRole('button', { name: '放大查看图片' }));
    rerender(<MarkdownImage src="/two.png" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(within(screen.getByRole('dialog')).getByRole('presentation').getAttribute('src')).toBe('/two.png');
  });

  it('previews a linked Markdown image without following its link', () => {
    render(<StreamingMarkdownView content={'[![截图](/api/artifacts/art_one/content)](https://example.com)'} />);
    expect(fireEvent.click(screen.getByRole('img', { name: '截图' }))).toBe(false);
    expect(within(screen.getByRole('dialog')).getByRole('img').getAttribute('src')).toBe('/api/artifacts/art_one/content');
  });

  it('shows the expired placeholder when an attachment fails to load', () => {
    render(<MarkdownImage src="/api/chat/attachments/att_abc" alt="首页截图" />);
    fireEvent.error(screen.getByRole('img', { name: '首页截图' }));
    expect(screen.getByRole('img', { name: '首页截图：图片已过期' }).tagName).toBe('SPAN');
    expect(screen.getByText('图片已过期').textContent).toBe('图片已过期');
  });

  it('keeps the description of a broken non-attachment image as text', () => {
    render(<MarkdownImage src="https://example.com/missing.png" alt="logo" />);
    fireEvent.error(screen.getByRole('img', { name: 'logo' }));
    expect(screen.queryByText('图片已过期')).toBeNull();
    expect(screen.getByText('logo').tagName).toBe('SPAN');
  });
});
