import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowEdgeDefinition, WorkflowNodeDefinition } from '@worklite/contracts';
import {
  commitWorkflowInvocation,
  createWorkflowRerunState,
  takeNextWorkflowInvocation,
  type WorkflowRerunHistoryEntry,
  type WorkflowSchedulerState,
} from './index';

function node(id: string, type = 'worklite/agent', typeVersion = '1'): WorkflowNodeDefinition {
  return { id, position: { x: 0, y: 0 }, type, typeVersion, config: {}, errorPolicy: 'stop' };
}

function edge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  targetPort = 'context',
  options: Partial<Pick<WorkflowEdgeDefinition, 'condition' | 'maxTraversals'>> = {},
): WorkflowEdgeDefinition {
  return { id, sourceNodeId, sourcePort: 'output', targetNodeId, targetPort, ...options };
}

function definition(nodes: WorkflowNodeDefinition[], edges: WorkflowEdgeDefinition[]): WorkflowDefinition {
  return { schemaVersion: 4, input: {}, defaults: { errorPolicy: 'stop' }, nodes, edges };
}

function state(overrides: Partial<WorkflowSchedulerState> = {}): WorkflowSchedulerState {
  return {
    ready: [],
    pendingInputs: {},
    joinBuffers: {},
    edgeTraversals: {},
    latestOutputs: {},
    terminalOutputs: {},
    nextPosition: 12,
    ...overrides,
  };
}

function history(nodeId: string, input: Record<string, unknown>, position: number): WorkflowRerunHistoryEntry {
  return { nodeId, input, position, status: 'succeeded' };
}

describe('createWorkflowRerunState', () => {
  it('clears only the direct target and leaves target activation to the caller', () => {
    const graph = definition([node('target'), node('unaffected')], []);
    const current = state({
      ready: [
        { nodeId: 'target', input: { context: 'stale' } },
        { nodeId: 'unaffected', input: { context: 'keep' } },
      ],
      active: { nodeId: 'target', input: { context: 'old' }, nodeRunId: 'nrun_old', position: 4 },
      latestOutputs: { target: 'old', unaffected: 'keep' },
      terminalOutputs: { target: 'old', unaffected: 'keep' },
    });

    const result = createWorkflowRerunState(graph, current, 'target', { context: 'exact input' }, [
      history('target', { context: 'old' }, 4),
    ]);

    expect(result.affectedNodeIds).toEqual(['target']);
    expect(result.state.active).toBeUndefined();
    expect(result.state.ready).toEqual([{ nodeId: 'unaffected', input: { context: 'keep' } }]);
    expect(result.state.latestOutputs).toEqual({ unaffected: 'keep' });
    expect(result.state.terminalOutputs).toEqual({ unaffected: 'keep' });
    expect(result.state.nextPosition).toBe(12);
    expect(current.active?.nodeRunId).toBe('nrun_old');
    expect(current.latestOutputs).toEqual({ target: 'old', unaffected: 'keep' });
  });

  it('invalidates every reachable branch even when old conditions selected another route', () => {
    const graph = definition(
      [node('target', 'worklite/branch'), node('left'), node('right'), node('leaf'), node('unaffected')],
      [
        edge('target-left', 'target', 'left', 'context', {
          condition: { kind: 'predicate', path: '$.route', operator: 'equals', value: 'left' },
        }),
        edge('target-right', 'target', 'right', 'context', { condition: { kind: 'fallback' } }),
        edge('left-leaf', 'left', 'leaf'),
        edge('right-leaf', 'right', 'leaf'),
      ],
    );
    const current = state({
      ready: [{ nodeId: 'right', input: { context: 'stale' } }],
      latestOutputs: { target: { route: 'left' }, left: 'old left', leaf: 'old leaf', unaffected: 'keep' },
      terminalOutputs: { leaf: 'old leaf', unaffected: 'keep' },
      edgeTraversals: { 'target-left': 1, 'left-leaf': 1 },
    });

    const result = createWorkflowRerunState(graph, current, 'target', {}, []);

    expect(new Set(result.affectedNodeIds)).toEqual(new Set(['target', 'left', 'right', 'leaf']));
    expect(result.state.ready).toEqual([]);
    expect(result.state.latestOutputs).toEqual({ unaffected: 'keep' });
    expect(result.state.terminalOutputs).toEqual({ unaffected: 'keep' });
    expect(result.state.edgeTraversals).toEqual({});
  });

  it('restores unaffected join slots in definition edge order and waits for fresh affected values', () => {
    const graph = definition(
      [node('upstream'), node('target'), node('join', 'worklite/join'), node('downstream')],
      [
        edge('upstream-join', 'upstream', 'join', 'input'),
        edge('target-join', 'target', 'join', 'input'),
        edge('join-downstream', 'join', 'downstream'),
      ],
    );
    const current = state({
      latestOutputs: { upstream: 'kept', target: 'old target', join: ['kept', 'old target'], downstream: 'old result' },
      terminalOutputs: { downstream: 'old result' },
      edgeTraversals: { 'upstream-join': 1, 'target-join': 1, 'join-downstream': 1 },
    });
    const entries = [
      history('join', { input: ['older upstream', 'older target'] }, 3),
      history('join', { input: ['kept upstream', 'old target'] }, 7),
    ];

    const result = createWorkflowRerunState(graph, current, 'target', { context: 'new input' }, entries);

    expect(result.state.joinBuffers).toEqual({ join: { 'upstream-join': ['kept upstream'] } });
    expect(result.state.pendingInputs).toEqual({});
    expect(result.state.ready).toEqual([]);
    expect(result.state.edgeTraversals).toEqual({ 'upstream-join': 1 });

    commitWorkflowInvocation(graph, result.state, 'target', 'new target');
    expect(result.state.ready).toEqual([
      { nodeId: 'join', input: { input: ['kept upstream', 'new target'] } },
    ]);
    expect(result.state.joinBuffers).toEqual({});
    expect(entries[1]?.input).toEqual({ input: ['kept upstream', 'old target'] });
  });

  it('restores only wholly unaffected input ports, including all values of a multiple port', () => {
    const graph = definition(
      [node('target'), node('cover'), node('images'), node('publish', 'wechat-official-account/publish', '2')],
      [
        edge('target-publish', 'target', 'publish', 'article'),
        edge('cover-publish', 'cover', 'publish', 'coverImage'),
        edge('images-publish', 'images', 'publish', 'images'),
      ],
    );
    const previousImages = [{ key: 'one' }, { key: 'two' }];
    const current = state({
      latestOutputs: { target: 'old article', cover: { key: 'cover' }, images: previousImages, publish: 'old result' },
      edgeTraversals: { 'target-publish': 1, 'cover-publish': 1, 'images-publish': 1 },
    });

    const result = createWorkflowRerunState(graph, current, 'target', {}, [
      history('publish', { article: 'old article', coverImage: { key: 'cover' }, images: previousImages }, 8),
    ]);

    expect(result.state.pendingInputs).toEqual({
      publish: {
        coverImage: [{ key: 'cover' }],
        images: previousImages,
      },
    });
    expect(result.state.edgeTraversals).toEqual({ 'cover-publish': 1, 'images-publish': 1 });

    commitWorkflowInvocation(graph, result.state, 'target', 'new article');
    expect(result.state.ready).toEqual([
      {
        nodeId: 'publish',
        input: { article: 'new article', coverImage: { key: 'cover' }, images: previousImages },
      },
    ]);
  });

  it('does not restore a port that mixes affected and unaffected sources', () => {
    const graph = definition(
      [node('target'), node('other'), node('upstream'), node('downstream', 'wechat-official-account/publish', '2')],
      [
        edge('target-downstream', 'target', 'downstream', 'article'),
        edge('other-downstream', 'other', 'downstream', 'article'),
        edge('upstream-downstream', 'upstream', 'downstream', 'coverImage'),
      ],
    );

    const result = createWorkflowRerunState(graph, state(), 'target', {}, [
      history('downstream', { article: 'must not return', coverImage: { key: 'keep' } }, 5),
    ]);

    expect(result.state.pendingInputs).toEqual({ downstream: { coverImage: [{ key: 'keep' }] } });
  });

  it('resets affected loop edges and still stops at their maxTraversals budget', () => {
    const graph = definition(
      [node('entry'), node('target'), node('loop'), node('outside'), node('outsideSink')],
      [
        edge('entry-target', 'entry', 'target'),
        edge('target-loop', 'target', 'loop'),
        edge('loop-target', 'loop', 'target', 'context', { maxTraversals: 2 }),
        edge('outside-sink', 'outside', 'outsideSink', 'context', { maxTraversals: 1 }),
      ],
    );
    const current = state({
      latestOutputs: { entry: 'entry', target: 'old target', loop: 'old loop', outside: 'outside' },
      edgeTraversals: { 'entry-target': 1, 'target-loop': 2, 'loop-target': 2, 'outside-sink': 1 },
    });

    const result = createWorkflowRerunState(graph, current, 'target', {}, []);
    expect(new Set(result.affectedNodeIds)).toEqual(new Set(['target', 'loop']));
    expect(result.state.edgeTraversals).toEqual({ 'entry-target': 1, 'outside-sink': 1 });

    commitWorkflowInvocation(graph, result.state, 'target', 'target 1');
    const executions: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const invocation = takeNextWorkflowInvocation(result.state);
      if (!invocation) break;
      executions.push(invocation.nodeId);
      commitWorkflowInvocation(graph, result.state, invocation.nodeId, `${invocation.nodeId} ${executions.length}`);
    }

    expect(executions).toEqual(['loop', 'target', 'loop', 'target', 'loop']);
    expect(result.state.ready).toEqual([]);
    expect(result.state.edgeTraversals['loop-target']).toBe(2);
  });

  it('restores a paused unaffected active invocation without losing existing ready or pending work', () => {
    const graph = definition(
      [node('target'), node('downstream'), node('active'), node('queued')],
      [edge('target-downstream', 'target', 'downstream')],
    );
    const current = state({
      active: { nodeId: 'active', input: { context: 'resume' }, nodeRunId: 'nrun_active', position: 3 },
      ready: [
        { nodeId: 'queued', input: { context: 'queued' } },
        { nodeId: 'downstream', input: { context: 'stale' } },
      ],
      pendingInputs: { queued: { systemPrompt: ['later'] }, downstream: { context: ['stale'] } },
      latestOutputs: { active: 'keep active', target: 'old target', downstream: 'old downstream' },
      nextPosition: 19,
    });

    const result = createWorkflowRerunState(graph, current, 'target', {}, []);

    expect(result.state.active).toBeUndefined();
    expect(result.state.ready).toEqual([
      { nodeId: 'active', input: { context: 'resume' } },
      { nodeId: 'queued', input: { context: 'queued' } },
    ]);
    expect(result.state.pendingInputs).toEqual({ queued: { systemPrompt: ['later'] } });
    expect(result.state.latestOutputs).toEqual({ active: 'keep active' });
    expect(result.state.nextPosition).toBe(19);
    expect(current.active?.nodeRunId).toBe('nrun_active');
    expect(current.ready).toHaveLength(2);
  });
});
