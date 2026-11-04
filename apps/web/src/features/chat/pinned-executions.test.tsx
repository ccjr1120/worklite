import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunDetailView } from '@worklite/contracts';
import '@/i18n/config';
import { api } from '@/api/client';
import { PinnedExecutionBar, usePinTracking, type PinCandidate } from './pinned-executions';

vi.mock('@/api/client', () => ({ api: { agentRun: vi.fn() } }));
vi.mock('@/api/queries', () => ({ useRunQuery: () => ({}), useAgentTeamRunQuery: () => ({}), useWorkliteUpgradeQuery: () => ({}) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const candidate: PinCandidate = { id: 'dispatch', kind: 'agent', invocation: { agentId: 'lead', agentName: 'wechat-article', runId: 'air_original', task: '写一篇文章' } };
const detail = (status: string) => ({ run: { status } }) as AgentRunDetailView;
function mount(above: Set<string>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onReveal = vi.fn();
  const view = (offscreen: Set<string>) => <QueryClientProvider client={client}><PinnedExecutionBar candidates={[candidate]} above={offscreen} onReveal={onReveal} /></QueryClientProvider>;
  const rendered = render(view(above));
  return { client, onReveal, rerender: (offscreen: Set<string>) => rendered.rerender(view(offscreen)) };
}

describe('offscreen Agent pins', () => {
  it('pins the actual running instance, reveals its message, and removes the pin when visible or finished', async () => {
    vi.mocked(api.agentRun).mockResolvedValue(detail('running'));
    const { client, onReveal, rerender } = mount(new Set(['dispatch']));
    expect(await screen.findByText('@wechat-article')).toBeVisible();
    expect(api.agentRun).toHaveBeenCalledWith('lead', 'air_original');
    expect(screen.getByText('写一篇文章')).toBeVisible();
    fireEvent.click(screen.getByRole('button'));
    expect(onReveal).toHaveBeenCalledWith('dispatch');
    rerender(new Set());
    expect(screen.queryByText('@wechat-article')).not.toBeInTheDocument();
    rerender(new Set(['dispatch']));
    expect(await screen.findByText('@wechat-article')).toBeVisible();
    act(() => client.setQueryData(['agent-run', 'lead', 'air_original'], detail('completed')));
    await waitFor(() => expect(screen.queryByText('@wechat-article')).not.toBeInTheDocument());
    client.clear();
  });

  it.each(['completed', 'failed', 'cancelled'])('does not pin a %s Agent', async (status) => {
    vi.mocked(api.agentRun).mockResolvedValue(detail(status));
    const { client } = mount(new Set(['dispatch']));
    await waitFor(() => expect(client.getQueryData(['agent-run', 'lead', 'air_original'])).toEqual(detail(status)));
    expect(screen.queryByText('@wechat-article')).not.toBeInTheDocument();
    client.clear();
  });

  it('tracks Agents outside either edge of the visible area and clears them on reentry', () => {
    let observe!: (entries: IntersectionObserverEntry[]) => void;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { observe = (entries) => callback(entries, this as unknown as IntersectionObserver); }
      observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    });
    function Fixture() {
      const host = useRef<HTMLDivElement>(null);
      const pins = usePinTracking(host);
      return <div ref={host}><div data-testid="card" ref={pins.context.track('dispatch', 'outside')} /><output>{pins.above.has('dispatch') ? 'pinned' : 'visible'}</output></div>;
    }
    render(<Fixture />);
    const target = screen.getByTestId('card');
    const entry = (isIntersecting: boolean, bottom: number): IntersectionObserverEntry[] => {
      const rect = new DOMRect(0, bottom - 10, 20, 10);
      return [{ target, isIntersecting, boundingClientRect: rect, intersectionRect: rect, intersectionRatio: isIntersecting ? 1 : 0, rootBounds: null, time: 0 }];
    };
    act(() => observe(entry(false, -10)));
    expect(screen.getByText('pinned')).toBeVisible();
    act(() => observe(entry(true, 20)));
    expect(screen.getByText('visible')).toBeVisible();
    act(() => observe(entry(false, 1000)));
    expect(screen.getByText('pinned')).toBeVisible();
  });
});
