import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PromptInput, PromptInputSubmit, PromptInputTextarea } from './prompt-input';

describe('AI Elements prompt input', () => {
  it('submits controlled text through the composed form', () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault());
    const onValueChange = vi.fn();
    render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea aria-label="Message" value="hello" onValueChange={onValueChange} />
        <PromptInputSubmit aria-label="Send">Send</PromptInputSubmit>
      </PromptInput>,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hello world' } });
    expect(onValueChange).toHaveBeenCalledWith('hello world');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('turns the submit control into a stop control while active', () => {
    const onStop = vi.fn();
    render(<PromptInputSubmit status="streaming" onStop={onStop} aria-label="Stop">Stop</PromptInputSubmit>);

    const button = screen.getByRole('button', { name: 'Stop' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
