import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTeamRunNode } from '@worklite/contracts';
import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RunNodeTable } from './run-nodes';

vi.mock('@/components/locale-provider', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
afterEach(cleanup);

const node: AgentTeamRunNode = {
  nodeRunId: 'attempt', taskKey: 'planning', attemptIndex: 0, name: 'Planner', role: 'planner', roleName: null,
  status: 'running', startedAt: '2026-10-30T00:00:00Z', endedAt: null, durationMs: 2000,
  tokens: { tokens: 120, source: 'exact' }, latestActivity: 'read', stepsOmitted: 0,
  steps: [{ id: 'step', kind: 'tool_call', label: 'read src/main.ts', startedAt: '2026-10-30T00:00:00Z', endedAt: null, durationMs: 1000, tokens: { tokens: 987, source: 'estimated' } }],
};

describe('RunNodeTable', () => {
  it('opens active nodes and shows their steps without step token figures', () => {
    render(<TooltipProvider><RunNodeTable nodes={[node]} /></TooltipProvider>);
    const step = screen.getByText('read src/main.ts').closest('li')!;
    expect(within(step).queryByText(/987/)).toBeNull();
    expect(screen.getByText('120')).toBeTruthy();
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByText('read src/main.ts')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByText('read src/main.ts')).toBeTruthy();
  });

  it('keeps finished nodes collapsed until opened', () => {
    render(<TooltipProvider><RunNodeTable nodes={[{ ...node, status: 'completed' }]} /></TooltipProvider>);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('read src/main.ts')).toBeNull();
  });
});
