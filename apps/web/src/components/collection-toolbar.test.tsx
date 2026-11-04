import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '@/i18n/config';
import { CollectionToolbar } from './collection-toolbar';
afterEach(cleanup);
function Search() { const [value, setValue] = useState('Agent'); return <CollectionToolbar search={value} onSearchChange={setValue} placeholder="查找" />; }
describe('collection search', () => {
  it('clears search and returns focus to the input', () => {
    render(<Search />);
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(screen.queryByRole('button', { name: '清除筛选' })).not.toBeInTheDocument();
  });
  it('clears with Escape without closing an enclosing surface', () => {
    let escaped = false;
    const listener = () => { escaped = true; };
    window.addEventListener('keydown', listener);
    render(<Search />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.getByRole('textbox')).toHaveValue('');
    window.removeEventListener('keydown', listener);
    expect(escaped).toBe(false);
  });
});
