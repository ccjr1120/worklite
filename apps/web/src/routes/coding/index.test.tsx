import { describe, expect, it, vi } from 'vitest';
import { Route } from './index';
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (options: { beforeLoad: () => void }) => ({ options }), redirect: (input: unknown) => input }));
describe('retired Coding Team page', () => {
  it('opens the unified Agents page', () => {
    expect(Route.options.beforeLoad).toBeDefined();
    try { (Route.options.beforeLoad as () => void)(); throw new Error('Expected redirect'); }
    catch (result) { expect(result).toEqual({ to: '/agents' }); }
  });
});
