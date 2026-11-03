import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CommandsController } from './commands.controller';

describe('command event stream', () => {
  it('replays all events before completing a finished command stream', async () => {
    const event = { commandId: 'cmd', sequence: 1, type: 'stdout', data: 'output' };
    const unsubscribe = vi.fn();
    const commands = { get: vi.fn().mockResolvedValue({ status: 'succeeded' }), events: vi.fn().mockResolvedValue([event]), subscribe: vi.fn().mockReturnValue(unsubscribe) };
    const request = new EventEmitter();
    const response = { status: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() };
    await new CommandsController(commands as never).events('cmd', undefined, request as never, response as never);
    expect(response.write.mock.calls.map(([value]) => value)).toEqual([expect.stringContaining('output'), 'event: complete\ndata: {}\n\n']);
    expect(response.end).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('completes an active stream after its terminal lifecycle event', async () => {
    let listener: (event: { commandId: string; sequence: number; type: 'lifecycle'; data: string }) => void = () => {};
    const commands = { get: vi.fn().mockResolvedValue({ status: 'running' }), events: vi.fn().mockResolvedValue([]), subscribe: vi.fn((fn) => { listener = fn; return vi.fn(); }) };
    const request = new EventEmitter();
    const response = { status: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() };
    await new CommandsController(commands as never).events('cmd', undefined, request as never, response as never);
    commands.get.mockResolvedValue({ status: 'succeeded' });
    listener({ commandId: 'cmd', sequence: 1, type: 'lifecycle', data: 'Command completed.' });
    await vi.waitFor(() => expect(response.end).toHaveBeenCalledOnce());
    expect(response.write.mock.calls.map(([value]) => value)).toEqual([expect.stringContaining('Command completed.'), 'event: complete\ndata: {}\n\n']);
  });
});
