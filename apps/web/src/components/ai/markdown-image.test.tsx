import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@/i18n/config';
import { MarkdownImage } from './markdown-image';

describe('MarkdownImage', () => {
  afterEach(cleanup);

  it('renders an attachment image with its description', () => {
    render(<MarkdownImage src="/api/chat/attachments/att_abc" alt="首页截图" />);
    const image = screen.getByRole('img', { name: '首页截图' });
    expect(image.tagName).toBe('IMG');
    expect(image.getAttribute('src')).toBe('/api/chat/attachments/att_abc');
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
