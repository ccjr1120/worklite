import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@/i18n/config';
import StreamingMarkdownView from './streaming-markdown-view';

describe('local image Artifacts in Web Chat Markdown', () => {
  afterEach(cleanup);

  it('renders every returned image reference through the shared Markdown image component', () => {
    render(<StreamingMarkdownView content={'![首页截图](/api/artifacts/art_one/content)\n\n![详情截图](/api/artifacts/art_two/content)'} />);
    expect(screen.getByRole('img', { name: '首页截图' }).getAttribute('src')).toBe('/api/artifacts/art_one/content');
    expect(screen.getByRole('img', { name: '详情截图' }).getAttribute('src')).toBe('/api/artifacts/art_two/content');
  });
});
