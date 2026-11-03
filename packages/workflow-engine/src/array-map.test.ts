import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '@worklite/contracts';
import {
  commitWorkflowInvocation,
  composeWorkflowArticle,
  createWorkflowSchedulerState,
  executeWorkflowMap,
  listWorkflowNodeCapabilities,
  resolveWorkflowNodeCapability,
  takeNextWorkflowInvocation,
  type WorkflowSchedulerState,
} from './index';

function node(id: string, type = 'worklite/agent', config: unknown = { model: 'test', systemPrompt: 'test', skillIds: [], mcpServerIds: [] }) {
  return { id, position: { x: 0, y: 0 }, type, typeVersion: '1', config, errorPolicy: 'stop' as const };
}

function edge(id: string, sourceNodeId: string, targetNodeId: string, targetPort = 'context', maxTraversals?: number) {
  return { id, sourceNodeId, sourcePort: 'output', targetNodeId, targetPort, ...(maxTraversals === undefined ? {} : { maxTraversals }) };
}

function definition(nodes: WorkflowDefinition['nodes'], edges: WorkflowDefinition['edges']): WorkflowDefinition {
  return { schemaVersion: 4, input: {}, defaults: { errorPolicy: 'stop' }, nodes, edges };
}

function image(key: string) {
  return { type: 'workflow_image', model: 'canvas', mediaType: 'image/png', key, data: [{ b64Json: 'AAAA' }] };
}

describe('worklite/map capability', () => {
  it('is registered with the array map contract and identity fields', () => {
    const capability = resolveWorkflowNodeCapability('worklite/map', '1');
    expect(capability).toBeDefined();
    expect(capability?.inputs.map((port) => [port.name, port.required])).toEqual([['items', true], ['context', false]]);
    expect(capability?.outputs[0]).toMatchObject({ name: 'output', multiple: true });
    const properties = capability?.configSchema.properties as Record<string, unknown>;
    expect(properties.subgraph).toBeDefined();
    expect(properties.bindings).toBeDefined();
    expect(resolveWorkflowNodeCapability('worklite/join', '1')?.aggregation).toBe('join');
    expect(listWorkflowNodeCapabilities().some((entry) => entry.id === 'worklite/compose-article' && entry.version === '1')).toBe(true);
  });

  it('returns an empty array for an empty item array without executing the subgraph', async () => {
    let calls = 0;
    const output = await executeWorkflowMap({
      itemsValue: [],
      context: {},
      config: { subgraph: { nodes: [node('step')], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async () => { calls += 1; return null; },
    });
    expect(output).toEqual([]);
    expect(calls).toBe(0);
  });

  it('runs one element and applies itemsPath and bindings', async () => {
    const seen: unknown[] = [];
    const output = await executeWorkflowMap({
      itemsValue: { images: [{ key: 'alpha', intent: 'first' }] },
      context: { topic: 'demo' },
      config: {
        itemsPath: '$.images',
        subgraph: { nodes: [node('render', 'worklite/canvas-render', { width: 1, height: 1 })], edges: [] },
        bindings: [{ nodeId: 'render', field: 'key', path: 'item.key' }],
        entryPort: 'code',
      },
      signal: new AbortController().signal,
      executeNode: async ({ input, config, item, index, context }) => {
        seen.push({ input, config, item, index, context });
        return (config as { key: string }).key;
      },
    });
    expect(output).toEqual(['alpha']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      input: { code: JSON.stringify({ key: 'alpha', intent: 'first' }) },
      config: { width: 1, height: 1, key: 'alpha' },
      item: { key: 'alpha', intent: 'first' },
      index: 0,
      context: { topic: 'demo' },
    });
  });

  it('keeps results in item-index order when later elements finish first', async () => {
    const output = await executeWorkflowMap({
      itemsValue: ['first', 'second', 'third'],
      context: {},
      config: { subgraph: { nodes: [node('step')], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async ({ item, index }) => {
        await new Promise((resolve) => setTimeout(resolve, (3 - index) * 5));
        return item;
      },
    });
    expect(output).toEqual(['first', 'second', 'third']);
  });

  it('runs image elements concurrently with a limit and retains input order', async () => {
    const started: number[] = [];
    const releases: Array<(() => void) | undefined> = [];
    const output = executeWorkflowMap({
      itemsValue: ['a', 'b', 'c', 'd'], context: {},
      config: { subgraph: { nodes: [node('render', 'worklite/canvas-render', {})], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async ({ index, item }) => {
        started.push(index);
        await new Promise<void>((resolve) => { releases[index] = resolve; });
        return item;
      },
    });
    expect(started).toEqual([0, 1, 2]);
    releases[2]!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[3]!(); releases[1]!(); releases[0]!();
    await expect(output).resolves.toEqual(['a', 'b', 'c', 'd']);
  });

  it('aborts other image elements and does not start new ones when an element fails', async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    await expect(executeWorkflowMap({
      itemsValue: [0, 1, 2, 3], context: {},
      config: { subgraph: { nodes: [node('render', 'worklite/canvas-render', {})], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async ({ index, signal }) => {
        started.push(index);
        if (index === 1) { await Promise.resolve(); throw new Error('failed'); }
        return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted.push(index); reject(new Error('aborted')); }, { once: true }));
      },
    })).rejects.toThrow('Map element 1 failed: failed');
    expect(started).toEqual([0, 1, 2]);
    expect(aborted.sort()).toEqual([0, 2]);
  });

  it('cancels active image elements when the workflow is cancelled', async () => {
    const controller = new AbortController();
    const aborted: number[] = [];
    const run = executeWorkflowMap({
      itemsValue: [0, 1, 2, 3], context: {},
      config: { subgraph: { nodes: [node('render', 'worklite/canvas-render', {})], edges: [] } },
      signal: controller.signal,
      executeNode: async ({ index, signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted.push(index); reject(new Error('aborted')); }, { once: true })),
    });
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(aborted.sort()).toEqual([0, 1, 2]);
  });

  it('skips failed image elements while retaining successful input order', async () => {
    const failures: number[] = [];
    const result = await executeWorkflowMap({
      itemsValue: [0, 1, 2], context: {},
      config: { continueOnError: true, subgraph: { nodes: [node('render', 'worklite/canvas-render', {})], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async ({ index }) => { if (index === 1) throw new Error('failed'); return index; },
      onElementError: (_error, index) => { failures.push(index); },
    });
    expect(result).toEqual([0, 2]);
    expect(failures).toEqual([1]);
  });

  it('keeps maps with non-image outputs serial', async () => {
    let active = 0;
    let maxActive = 0;
    await executeWorkflowMap({
      itemsValue: [1, 2, 3], context: {}, config: { subgraph: { nodes: [node('step')], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async ({ item }) => { active += 1; maxActive = Math.max(maxActive, active); await Promise.resolve(); active -= 1; return item; },
    });
    expect(maxActive).toBe(1);
  });

  it('reruns a failed element from its first node when the subgraph opts into retries', async () => {
    // The Agent writes a script that does not compile; retrying only the renderer would replay the
    // same script, so the element reruns and the Agent writes a new one.
    const script = { ...node('script'), errorPolicy: 'retry' as const };
    const render = { ...node('render', 'worklite/canvas-render', { width: 1080, height: 720 }), errorPolicy: 'retry' as const };
    const calls: string[] = [];
    let scripts = 0;
    const output = await executeWorkflowMap({
      itemsValue: ['fig-a'],
      context: {},
      config: { subgraph: { nodes: [script, render], edges: [edge('e1', 'script', 'render', 'code')] }, outputNodeId: 'render' },
      signal: new AbortController().signal,
      executeNode: async ({ node: current, input }) => {
        calls.push(current.id);
        if (current.id === 'script') {
          scripts += 1;
          return scripts === 1 ? '我设计了一张对比图。' : 'ctx.fillRect(0, 0, 10, 10);';
        }
        if (!String((input as { code?: unknown }).code).startsWith('ctx.')) throw new Error('Invalid or unexpected token');
        return image('fig-a');
      },
    });
    expect(output).toEqual([image('fig-a')]);
    expect(calls).toEqual(['script', 'render', 'render', 'script', 'render']);
  });

  it('does not rerun an element when no subgraph node opts into retries', async () => {
    let calls = 0;
    await expect(executeWorkflowMap({
      itemsValue: ['bad'],
      context: {},
      config: { subgraph: { nodes: [node('step')], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async () => { calls += 1; throw new Error('element exploded'); },
    })).rejects.toThrow('Map element 0 failed: element exploded');
    expect(calls).toBe(1);
  });

  it('fails the whole node on an element failure by default', async () => {
    await expect(executeWorkflowMap({
      itemsValue: ['ok', 'bad', 'later'],
      context: {},
      config: { subgraph: { nodes: [node('step')], edges: [] } },
      signal: new AbortController().signal,
      executeNode: async ({ item }) => {
        if (item === 'bad') throw new Error('element exploded');
        return item;
      },
    })).rejects.toThrow('element exploded');
  });

  it('skips failed elements and preserves the remaining index order when continueOnError is set', async () => {
    const failures: number[] = [];
    const output = await executeWorkflowMap({
      itemsValue: ['a', 'b', 'c', 'd'],
      context: {},
      config: { subgraph: { nodes: [node('step')], edges: [] }, continueOnError: true },
      signal: new AbortController().signal,
      executeNode: async ({ item }) => {
        if (item === 'b' || item === 'd') throw new Error(`failed ${item}`);
        return item;
      },
      onElementError: (_error, index) => { failures.push(index); },
    });
    expect(output).toEqual(['a', 'c']);
    expect(failures).toEqual([1, 3]);
  });

  it('runs a bounded cycle inside the subgraph without escaping the traversal limit', async () => {
    const executions: string[] = [];
    const subgraph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a-to-b', 'a', 'b'), edge('b-to-a', 'b', 'a', 'context', 1)],
    };
    const output = await executeWorkflowMap({
      itemsValue: [{ value: 'x' }],
      context: {},
      config: { subgraph, outputNodeId: 'b' },
      signal: new AbortController().signal,
      executeNode: async ({ node: current, input }) => {
        executions.push(current.id);
        return { node: current.id, input };
      },
    });
    expect(executions).toEqual(['a', 'b', 'a', 'b']);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ node: 'b' });
  });

  it('rejects a subgraph whose cycle has no bounded edge', async () => {
    await expect(executeWorkflowMap({
      itemsValue: [1],
      context: {},
      config: {
        subgraph: {
          nodes: [node('a'), node('b')],
          edges: [edge('a-to-b', 'a', 'b'), edge('b-to-a', 'b', 'a')],
        },
      },
      signal: new AbortController().signal,
      executeNode: async () => null,
    })).rejects.toThrow('maximum traversal count');
  });

  it('expands again on each pass of an outer bounded cycle and stops at the limit', async () => {
    const graph = definition(
      [
        node('collect', 'worklite/agent', {}),
        node('expand', 'worklite/map', { subgraph: { nodes: [node('step')], edges: [] } }),
        node('after', 'worklite/agent', {}),
      ],
      [
        edge('collect-expand', 'collect', 'expand', 'items'),
        edge('expand-after', 'expand', 'after'),
        edge('after-collect', 'after', 'collect', 'context', 1),
      ],
    );
    const state = createWorkflowSchedulerState(graph);
    const order: string[] = [];
    const mapOutputs: unknown[] = [];
    while (true) {
      const invocation = takeNextWorkflowInvocation(state);
      if (!invocation) break;
      order.push(invocation.nodeId);
      let output: unknown;
      if (invocation.nodeId === 'expand') {
        output = await executeWorkflowMap({
          itemsValue: invocation.input.items,
          context: invocation.input.context,
          config: (graph.nodes.find((entry) => entry.id === 'expand')!).config,
          signal: new AbortController().signal,
          executeNode: async ({ item }) => item,
        });
        mapOutputs.push(output);
      } else if (invocation.nodeId === 'collect') {
        output = ['first', 'second'];
      } else {
        output = invocation.input;
      }
      commitWorkflowInvocation(graph, state, invocation.nodeId, output);
    }
    expect(order).toEqual(['collect', 'expand', 'after', 'collect', 'expand', 'after']);
    expect(mapOutputs).toEqual([['first', 'second'], ['first', 'second']]);
  });
});

describe('worklite/join barrier', () => {
  function runJoin(definitionValue: WorkflowDefinition, outputs: Record<string, unknown>): { joinInput: unknown; state: WorkflowSchedulerState; order: string[] } {
    const state = createWorkflowSchedulerState(definitionValue);
    const order: string[] = [];
    let joinInput: unknown;
    while (true) {
      const invocation = takeNextWorkflowInvocation(state);
      if (!invocation) break;
      order.push(invocation.nodeId);
      const capability = resolveWorkflowNodeCapability(
        definitionValue.nodes.find((entry) => entry.id === invocation.nodeId)!.type,
        definitionValue.nodes.find((entry) => entry.id === invocation.nodeId)!.typeVersion,
      );
      if (capability?.aggregation === 'join') {
        joinInput = invocation.input.input;
        commitWorkflowInvocation(definitionValue, state, invocation.nodeId, joinInput);
        continue;
      }
      commitWorkflowInvocation(definitionValue, state, invocation.nodeId, outputs[invocation.nodeId]);
    }
    return { joinInput, state, order };
  }

  it('waits for every sibling branch and emits values in definition edge order', () => {
    const graph = definition(
      [node('first'), node('second'), node('third'), node('join', 'worklite/join', {})],
      [
        edge('first-to-join', 'first', 'join', 'input'),
        edge('second-to-join', 'second', 'join', 'input'),
        edge('third-to-join', 'third', 'join', 'input'),
      ],
    );
    const { joinInput, order } = runJoin(graph, { first: 'a', second: 'b', third: 'c' });
    expect(order).toEqual(['first', 'second', 'third', 'join']);
    expect(joinInput).toEqual(['a', 'b', 'c']);
  });

  it('orders aggregated values with orderBy without changing the item count', () => {
    const graph = definition(
      [node('first'), node('second'), node('third'), node('join', 'worklite/join', { orderBy: { path: 'rank', direction: 'desc' } })],
      [
        edge('first-to-join', 'first', 'join', 'input'),
        edge('second-to-join', 'second', 'join', 'input'),
        edge('third-to-join', 'third', 'join', 'input'),
      ],
    );
    const { joinInput } = runJoin(graph, {
      first: { rank: 1, name: 'low' },
      second: { rank: 3, name: 'high' },
      third: { rank: 2, name: 'mid' },
    });
    expect(joinInput).toEqual([{ rank: 3, name: 'high' }, { rank: 2, name: 'mid' }, { rank: 1, name: 'low' }]);
  });

  it('does not fire the join while a sibling is still missing', () => {
    const graph = definition(
      [node('first'), node('second'), node('join', 'worklite/join', {})],
      [edge('first-to-join', 'first', 'join', 'input'), edge('second-to-join', 'second', 'join', 'input')],
    );
    const state = createWorkflowSchedulerState(graph);
    const first = takeNextWorkflowInvocation(state)!;
    commitWorkflowInvocation(graph, state, first.nodeId, 'a');
    // The second root was already ready; it is not the join.
    expect(state.ready.map((entry) => entry.nodeId)).toEqual(['second']);
    const second = takeNextWorkflowInvocation(state)!;
    commitWorkflowInvocation(graph, state, second.nodeId, 'b');
    expect(state.ready).toHaveLength(1);
    expect(state.ready[0]).toEqual({ nodeId: 'join', input: { input: ['a', 'b'] } });
  });
});

describe('composeWorkflowArticle', () => {
  const coverImage = { type: 'workflow_image', model: 'codex/gpt-image-2', mediaType: 'image/png', data: [{ b64Json: 'COVER' }] };

  function compose(article: string, images: unknown[], options: { title?: string; config?: unknown; cover?: unknown } = {}) {
    return composeWorkflowArticle({
      article: { title: options.title ?? 'Title', article },
      images,
      coverImage: 'cover' in options ? options.cover : coverImage,
    }, options.config);
  }

  it('accepts one H1, resolvable placeholders, and a cover image', () => {
    const markdown = '# Title\n\n![hero](worklite-image:hero)\n\nBody.';
    expect(compose(markdown, [image('hero')])).toBe(markdown);
  });

  it('accepts the one-level nested array produced by a multiple image port', () => {
    const markdown = '# Title\n\n![hero](worklite-image:hero)';
    expect(compose(markdown, [[image('hero')]])).toBe(markdown);
  });

  it('fails when a placeholder has no matching image', () => {
    expect(() => compose('# Title\n\n![hero](worklite-image:missing)', [image('hero')]))
      .toThrow('missing image "missing"');
  });

  it('fails when duplicate image keys are supplied', () => {
    expect(() => compose('# Title\n\n![hero](worklite-image:hero)', [image('hero'), image('hero')]))
      .toThrow('duplicate image key');
  });

  it('fails when the H1 count is not exactly one', () => {
    expect(() => compose('No heading', [])).toThrow('exactly one H1');
    expect(() => compose('# One\n\n# Two', [])).toThrow('exactly one H1');
  });

  it('fails when the H1 does not match the planner title', () => {
    expect(() => compose('# Other', [], { title: 'Title' })).toThrow('does not match title');
  });

  it('fails when a code fence is not closed', () => {
    expect(() => compose('# Title\n\n```ts\nconst a = 1;', [])).toThrow('code fence');
  });

  it('does not treat a heading inside a code fence as an H1', () => {
    const markdown = '# Title\n\n```md\n# Not a heading\n```\n\nBody';
    expect(compose(markdown, [])).toBe(markdown);
  });

  it('fails when the cover image is missing or malformed', () => {
    expect(() => compose('# Title', [], { cover: null })).toThrow('Cover image');
    expect(() => compose('# Title', [], { cover: { type: 'workflow_image' } })).toThrow('Cover image');
  });

  it('drops unused images by default and appends them when configured', () => {
    const markdown = '# Title\n\n![hero](worklite-image:hero)';
    expect(compose(markdown, [image('hero'), image('spare')])).toBe(markdown);
    expect(compose(markdown, [image('hero'), image('spare')], { config: { unusedImagePolicy: 'append' } }))
      .toBe('# Title\n\n![hero](worklite-image:hero)\n\n![spare](worklite-image:spare)\n');
  });

  it('supports custom title and article paths for object-shaped article inputs', () => {
    expect(composeWorkflowArticle({
      article: { draft: { heading: 'Title', body: '# Title\n\nBody' } },
      images: [],
      coverImage,
    }, { titlePath: 'draft.heading', articlePath: 'draft.body' })).toBe('# Title\n\nBody');
  });
});
