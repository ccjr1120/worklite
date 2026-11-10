// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandExecutions, createDb, initializeDatabase, type Database } from '@worklite/db';
import { CommandsService } from './commands.service';
let db: Database;
let service: CommandsService;
beforeEach(async () => { db = createDb(':memory:'); await initializeDatabase(db); service = new CommandsService(db); });
afterEach(() => { vi.restoreAllMocks(); db.$client.close(); });
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

describe('command stream persistence', () => {
  it('commits interleaved streams in one insert with stable replay cursors', async () => {
    db.insert(commandExecutions).values({ id: 'command', command: 'test', cwd: '/', status: 'running' }).run();
    const prepare = vi.spyOn(db.$client, 'prepare');
    const seen: number[] = [];
    service.subscribe((event) => seen.push(event.sequence));
    const chunks = Array.from({ length: 100 }, (_, i) => ({ type: i % 2 ? 'stderr' as const : 'stdout' as const, data: `汉🦊${i}\n` }));
    await (service as unknown as { persistEvents(id: string, values: typeof chunks): Promise<void> }).persistEvents('command', chunks);
    const inserts = prepare.mock.calls.filter(([sql]) => /insert into "command_execution_events"/i.test(sql));
    expect(inserts).toHaveLength(1);
    const events = await service.events('command');
    expect(events.map(({ type, data }) => ({ type, data }))).toEqual(chunks);
    expect(seen).toEqual(events.map((event) => event.sequence));
    expect(await service.events('command', events[49].sequence)).toEqual(events.slice(50));
  });

  it('flushes UTF-8 output before terminal lifecycle events and completion', async () => {
    const script = `for (let i=0;i<100;i++) { process.stdout.write('汉🦊'+i+'\\n'); process.stderr.write('错误'+i+'\\n'); }`;
    const created = await service.create({ command: `${quote(process.execPath)} -e ${quote(script)}` });
    const result = await service.waitForCompletion(created.id);
    expect(result.status).toBe('succeeded');
    expect(await service.output(created.id, 'stdout')).toBe(Array.from({ length: 100 }, (_, i) => `汉🦊${i}\n`).join(''));
    expect(await service.output(created.id, 'stderr')).toBe(Array.from({ length: 100 }, (_, i) => `错误${i}\n`).join(''));
    const events = await service.events(created.id);
    expect(events.at(-1)).toMatchObject({ type: 'lifecycle', data: 'Command completed.' });
  });
});
