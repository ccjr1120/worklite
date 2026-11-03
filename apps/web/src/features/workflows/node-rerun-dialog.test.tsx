import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunView, WorkflowDefinition, WorkflowNodeDefinition, WorkflowNodeRunView } from '@worklite/contracts';
import '@/i18n/config';
import { ApiError, api } from '@/api/client';
import { queryClient } from '@/lib/query-client';
import { NodeRerunDialog } from './node-rerun-dialog';

vi.mock('@/api/queries', () => ({
  useModelProvidersQuery: () => ({
    data: [
      { id: 'provider_1', name: 'gateway', protocol: 'openai/responses', models: ['current', 'new'] },
      { id: 'provider_2', name: 'system', protocol: 'typesafe/systemone', models: ['excluded'] },
    ],
    isLoading: false,
  }),
}));

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, api: { ...actual.api, rerunRunNode: vi.fn() } };
});

vi.mock('@/lib/query-client', () => ({
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn(() => Promise.resolve()) },
}));

function node(overrides: Partial<WorkflowNodeDefinition>): WorkflowNodeDefinition {
  return {
    id: 'target',
    type: 'worklite/agent',
    typeVersion: '1',
    position: { x: 0, y: 0 },
    config: { model: 'gateway/current' },
    errorPolicy: 'stop',
    ...overrides,
  };
}

function nodeRun(overrides: Partial<WorkflowNodeRunView> = {}): WorkflowNodeRunView {
  return {
    id: 'nrun_target',
    runId: 'run_1',
    nodeId: 'target',
    position: 1,
    type: 'worklite/agent',
    typeVersion: '1',
    status: 'succeeded',
    input: { text: '保留输入' },
    output: { text: '旧输出' },
    artifactIds: [],
    error: null,
    retryCount: 0,
    retryable: false,
    rerunnable: true,
    rerunEvidence: null,
    supersededByNodeRunId: null,
    startedAt: '2026-11-03T00:00:00.000Z',
    finishedAt: '2026-11-03T00:01:00.000Z',
    streamedOutput: null,
    activity: [],
    ...overrides,
  };
}

const downstream = node({ id: 'downstream', type: 'worklite/compose-article', config: {} });
const unrelated = node({ id: 'unrelated', type: 'worklite/compose-article', config: {} });
const baseDefinition: WorkflowDefinition = {
  schemaVersion: 1,
  input: {},
  defaults: { errorPolicy: 'stop' },
  nodes: [node({}), downstream, unrelated],
  edges: [{ id: 'edge_1', sourceNodeId: 'target', sourcePort: 'output', targetNodeId: 'downstream', targetPort: 'input' }],
};
const targetRun = nodeRun();
const downstreamRun = nodeRun({ id: 'nrun_downstream', nodeId: 'downstream', position: 2, type: 'worklite/compose-article' });
const unrelatedRun = nodeRun({ id: 'nrun_unrelated', nodeId: 'unrelated', position: 3, type: 'worklite/compose-article' });
const baseRun: RunView = {
  id: 'run_1',
  workspaceSlug: 'personal',
  workflowId: 'workflow_1',
  workflowName: '测试工作流',
  version: 'v1',
  status: 'succeeded',
  currentStep: null,
  startedAt: '2026-11-03T00:00:00.000Z',
  durationSeconds: 60,
  initiator: 'You',
  hasArtifactNode: false,
  resumable: false,
  nodeRuns: [targetRun, downstreamRun, unrelatedRun],
};
const nodeLabels = new Map([
  ['target', '调研与策划'],
  ['downstream', '配图批量生成'],
  ['unrelated', '不相关节点'],
  ['publish', '公众号发布'],
]);

function renderDialog({ definition = baseDefinition, target = targetRun, run = baseRun }: { definition?: WorkflowDefinition; target?: WorkflowNodeRunView; run?: RunView } = {}) {
  const onClose = vi.fn();
  render(<NodeRerunDialog run={run} nodeRun={target} definition={definition} nodeLabel="调研与策划" nodeLabels={nodeLabels} onClose={onClose} />);
  return { onClose };
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  vi.mocked(api.rerunRunNode).mockResolvedValue({ ...baseRun, status: 'queued' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NodeRerunDialog', () => {
  it('defaults an Agent to its current model, lists only affected existing downstream nodes, and submits the selected model', async () => {
    const { onClose } = renderDialog();
    const model = screen.getByRole('combobox', { name: '本次重跑使用的模型' });
    expect(model).toHaveTextContent('gateway/current');
    expect(screen.getByText('配图批量生成')).toBeVisible();
    expect(screen.queryByText('不相关节点')).not.toBeInTheDocument();

    fireEvent.click(model);
    fireEvent.click(await screen.findByRole('option', { name: 'gateway/new' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }));

    await waitFor(() => expect(api.rerunRunNode).toHaveBeenCalledWith('personal', 'run_1', 'nrun_target', { modelOverride: 'gateway/new' }));
    expect(queryClient.setQueryData).toHaveBeenCalledWith(['run', 'run_1'], expect.objectContaining({ status: 'queued' }));
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['runs'] });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps an Agent fallback model list unchanged by omitting the override', async () => {
    const definition = { ...baseDefinition, nodes: [node({ config: { model: ['gateway/current', 'gateway/new'] } }), downstream, unrelated] };
    renderDialog({ definition });
    expect(screen.getByRole('combobox', { name: '本次重跑使用的模型' })).toHaveTextContent('沿用当前模型');
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }));
    await waitFor(() => expect(api.rerunRunNode).toHaveBeenCalledWith('personal', 'run_1', 'nrun_target', {}));
  });

  it('does not show model selection for a non-Agent node', async () => {
    const compose = node({ type: 'worklite/compose-article', config: {} });
    const definition = { ...baseDefinition, nodes: [compose], edges: [] };
    const target = nodeRun({ type: 'worklite/compose-article' });
    const run = { ...baseRun, nodeRuns: [target] };
    renderDialog({ definition, target, run });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }));
    await waitFor(() => expect(api.rerunRunNode).toHaveBeenCalledWith('personal', 'run_1', 'nrun_target', {}));
  });

  it('requires explicit confirmation before rerunning downstream publishing side effects', async () => {
    const publish = node({ id: 'publish', type: 'wechat-official-account/publish', config: {} });
    const definition = {
      ...baseDefinition,
      nodes: [node({}), publish],
      edges: [{ id: 'edge_publish', sourceNodeId: 'target', sourcePort: 'output', targetNodeId: 'publish', targetPort: 'input' }],
    };
    const publishRun = nodeRun({ id: 'nrun_publish', nodeId: 'publish', type: 'wechat-official-account/publish' });
    renderDialog({ definition, run: { ...baseRun, nodeRuns: [targetRun, publishRun] } });
    const confirm = screen.getByRole('button', { name: '确认重跑' });
    expect(screen.getByText('公众号发布')).toBeVisible();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认重跑会再次执行公众号草稿/发布操作。' }));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.rerunRunNode).toHaveBeenCalledWith('personal', 'run_1', 'nrun_target', { modelOverride: 'gateway/current', confirmSideEffects: true }));
  });

  it('shows a busy state and maps stable API error codes to Chinese feedback', async () => {
    let rejectRequest: ((error: ApiError) => void) | undefined;
    vi.mocked(api.rerunRunNode).mockReturnValue(new Promise((_, reject) => { rejectRequest = reject; }));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '确认重跑' }));
    expect(screen.getByRole('button', { name: '正在发起重跑...' })).toBeDisabled();
    await act(async () => {
      rejectRequest?.(new ApiError(400, 'server message', undefined, undefined, undefined, 'RUN_NODE_RERUN_INVALID_MODEL'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('模型覆盖无效，仅 Agent 节点可使用支持 Agent 执行的公开模型。');
    expect(screen.getByRole('button', { name: '确认重跑' })).toBeEnabled();
  });
});
