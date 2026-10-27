import { Bot, Braces, FileCheck2, FileSearch, FileText, GitBranch, GitMerge, Image as ImageIcon, Layers, LayoutDashboard, ListChecks, Palette, Send, Sticker, Timer } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { WorkflowDashboardLayout, WorkflowEdgeCondition } from '@worklite/contracts';
import { cn } from '@/lib/utils';

export type WorkflowCanvasNodeType = 'input' | 'timer' | 'agent' | 'branch' | 'systemOne' | 'systemOneMap' | 'dashboard' | 'artifact' | 'artifactQuery' | 'wechatPublish' | 'image' | 'canvasSticker' | 'canvasRender' | 'map' | 'join' | 'compose';

export type WorkflowSystemOneRank = {
  path: string;
  order?: 'asc' | 'desc';
  limit?: number;
  minimum?: number;
};

export type WorkflowCanvasNodeData = {
  nodeType: WorkflowCanvasNodeType;
  label: string;
  description?: string;
  model?: string;
  systemPrompt?: string;
  outputFormat?: 'text' | 'json';
  systemOneQuestions?: Record<string, unknown>;
  systemOneItemsPath?: string;
  systemOneContextPath?: string;
  systemOneConcurrency?: number;
  systemOneRank?: WorkflowSystemOneRank;
  mcpServerIds?: string[];
  mcpServerNames?: string[];
  timerEnabled?: boolean;
  timerIntervalSeconds?: number;
  skillIds?: string[];
  skillNames?: string[];
  dashboardLayout?: WorkflowDashboardLayout;
  artifactName?: string;
  artifactType?: 'text' | 'markdown' | 'json' | 'image';
  artifactImageRole?: 'inline' | 'asset';
  queryName?: string;
  queryTitleField?: string;
  queryDescriptionFields?: string[];
  wechatAccountId?: string;
  wechatMode?: 'draft' | 'publish';
  wechatNodeVersion?: '1' | '2';
  imageCount?: number;
  imageKey?: string;
  imageBackground?: 'opaque' | 'transparent';
  imageQuality?: 'low' | 'medium' | 'high';
  imageSize?: '1024x1024' | '1536x1024' | '1024x1536';
  stickerWidth?: number;
  stickerHeight?: number;
  stickerShape?: 'none' | 'roundedRect' | 'circle' | 'ribbon';
  stickerBackgroundColor?: string;
  stickerKey?: string;
  stickerCornerRadius?: number;
  stickerTextContent?: string;
  stickerTextColor?: string;
  stickerTextFontSize?: number;
  stickerTextFontFamily?: 'sans-serif' | 'serif' | 'monospace';
  stickerTextAlign?: 'left' | 'center' | 'right';
  renderWidth?: number;
  renderHeight?: number;
  renderBackgroundColor?: string;
  renderKey?: string;
  renderTimeoutMs?: number;
  renderMaxOutputBytes?: number;
  /**
   * Original node config, kept so the inspector can round-trip fields it does
   * not render (output contracts, subgraphs, bindings) without losing them.
   */
  rawConfig?: Record<string, unknown>;
  errorPolicy: 'stop' | 'retry';
};

export type WorkflowCanvasNode = {
  id: string;
  type: WorkflowCanvasNodeType;
  position: { x: number; y: number };
  data: WorkflowCanvasNodeData;
  selected?: boolean;
  className?: string;
};

export type WorkflowCanvasEdgeData = {
  condition?: WorkflowEdgeCondition;
  maxTraversals?: number;
};

export type WorkflowCanvasEdge = {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  data?: WorkflowCanvasEdgeData;
  label?: string;
  selected?: boolean;
  className?: string;
};

export type WorkflowConnection = {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
};

type WorkflowNodeInput = { id: string; label: string };

export function workflowNodeInputs(node: WorkflowCanvasNode, t: TFunction<'workflows'>): WorkflowNodeInput[] {
  const inputs: Record<WorkflowCanvasNodeType, WorkflowNodeInput[]> = {
    input: [],
    timer: [],
    agent: [{ id: 'context', label: t('editor.contextPort') }],
    branch: [{ id: 'value', label: t('editor.branchValuePort') }],
    systemOne: [{ id: 'state', label: t('editor.systemOneStatePort') }],
    systemOneMap: [{ id: 'state', label: t('editor.systemOneStatePort') }],
    dashboard: [{ id: 'data', label: t('editor.dataPort') }],
    artifact: [{ id: 'data', label: t('editor.dataPort') }],
    artifactQuery: [{ id: 'request', label: t('editor.queryRequestPort') }],
    wechatPublish: [
      { id: 'article', label: t('editor.wechatArticlePort') },
      { id: 'metadata', label: t('editor.wechatMetadataPort') },
      ...(node.data.wechatNodeVersion === '1' ? [] : [
        { id: 'coverImage', label: t('editor.wechatCoverPort') },
        { id: 'images', label: t('editor.wechatImagesPort') },
      ]),
    ],
    image: [{ id: 'prompt', label: t('editor.imagePromptPort') }],
    canvasSticker: [{ id: 'text', label: t('editor.stickerTextPort') }],
    canvasRender: [{ id: 'code', label: t('editor.renderCodePort') }],
    map: [
      { id: 'items', label: t('editor.mapItemsPort') },
      { id: 'context', label: t('editor.mapContextPort') },
    ],
    join: [{ id: 'input', label: t('editor.joinInputPort') }],
    compose: [
      { id: 'article', label: t('editor.composeArticlePort') },
      { id: 'images', label: t('editor.composeImagesPort') },
      { id: 'coverImage', label: t('editor.composeCoverPort') },
    ],
  };
  return inputs[node.data.nodeType];
}

function workflowNodeKind(nodeType: WorkflowCanvasNodeType, t: TFunction<'workflows'>): string {
  const kinds: Record<WorkflowCanvasNodeType, string> = {
    input: t('editor.workflowInputNode'),
    timer: t('editor.timerNode'),
    agent: t('editor.agentNode'),
    branch: t('editor.branchNode'),
    systemOne: t('editor.systemOneNode'),
    systemOneMap: t('editor.systemOneMapNode'),
    dashboard: t('editor.dashboardNode'),
    artifact: t('editor.artifactNode'),
    artifactQuery: t('editor.artifactQueryNode'),
    wechatPublish: t('editor.wechatNode'),
    image: t('editor.imageNode'),
    canvasSticker: t('editor.stickerNode'),
    canvasRender: t('editor.renderNode'),
    map: t('editor.mapNode'),
    join: t('editor.joinNode'),
    compose: t('editor.composeNode'),
  };
  return kinds[nodeType];
}

export function workflowNodeRowCount(node: WorkflowCanvasNode, t: TFunction<'workflows'>): number {
  return Math.max(workflowNodeInputs(node, t).length, 1);
}

export function workflowNodePortOffset(rowCount: number, rowIndex: number): number {
  return 80 + (rowIndex - (rowCount - 1) / 2) * 24;
}

const iconClass = 'size-4 shrink-0 text-muted-foreground';

export function WorkflowStageNode({
  node,
  selected,
  keyboardSource,
  connectionTarget,
  connectionSource,
  readOnly = false,
  statusIndicator,
  statusDescription,
  onSelect,
  onStartConnection,
  onKeyboardConnectStart,
  onKeyboardConnectTarget,
}: {
  node: WorkflowCanvasNode;
  selected: boolean;
  keyboardSource: boolean;
  connectionTarget?: { nodeId: string; portId: string; valid: boolean };
  connectionSource?: { nodeId: string; portId: string; valid: boolean };
  readOnly?: boolean;
  statusIndicator?: ReactNode;
  statusDescription?: string;
  onSelect: (nodeId: string) => void;
  onStartConnection?: (nodeId: string, portId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyboardConnectStart?: (nodeId: string, portId: string) => void;
  onKeyboardConnectTarget?: (nodeId: string, portId: string) => void;
}) {
  const { t } = useTranslation('workflows');
  const icon = {
    input: <Braces className={iconClass} aria-hidden="true" />,
    timer: <Timer className={iconClass} aria-hidden="true" />,
    agent: <Bot className={iconClass} aria-hidden="true" />,
    branch: <GitBranch className={iconClass} aria-hidden="true" />,
    systemOne: <Braces className={iconClass} aria-hidden="true" />,
    systemOneMap: <ListChecks className={iconClass} aria-hidden="true" />,
    dashboard: <LayoutDashboard className={iconClass} aria-hidden="true" />,
    artifact: <FileText className={iconClass} aria-hidden="true" />,
    artifactQuery: <FileSearch className={iconClass} aria-hidden="true" />,
    wechatPublish: <Send className={iconClass} aria-hidden="true" />,
    image: <ImageIcon className={iconClass} aria-hidden="true" />,
    canvasSticker: <Sticker className={iconClass} aria-hidden="true" />,
    canvasRender: <Palette className={iconClass} aria-hidden="true" />,
    map: <Layers className={iconClass} aria-hidden="true" />,
    join: <GitMerge className={iconClass} aria-hidden="true" />,
    compose: <FileCheck2 className={iconClass} aria-hidden="true" />,
  }[node.data.nodeType];
  const kind = workflowNodeKind(node.data.nodeType, t);
  // The author-facing label wins; a definition without one keeps showing the type name.
  const title = node.data.label.trim() || kind;
  const description = node.data.description?.trim() || undefined;
  const inputs = workflowNodeInputs(node, t);
  const rowCount = Math.max(inputs.length, 1);

  return (
    // Pointer selection is a convenience duplicate of the heading button and port controls.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <div
      className={cn('workflow-flow-node', node.className, selected && 'workflow-node-selected')}
      data-flow-node={node.id}
      data-selected={selected || undefined}
      role="group"
      aria-label={`${title}, ${kind}${description ? `, ${description}` : ''}${statusDescription ? `, ${statusDescription}` : ''}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('[data-flow-port-type]')) return;
        onSelect(node.id);
      }}
    >
      <button type="button" className="workflow-node-heading" aria-pressed={selected} onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}>
        {icon}
        <span className="min-w-0 text-left">
          <span className="workflow-node-title" title={title}>{title}</span>
          {description
            ? <span className="workflow-node-description" title={description}>{description}</span>
            : title !== kind ? <span className="workflow-node-kind">{kind}</span> : null}
        </span>
        {statusIndicator}
      </button>
      <div className="workflow-node-ports" style={{ gridTemplateRows: `repeat(${rowCount}, 24px)` }}>
        {Array.from({ length: rowCount }, (_, index) => {
          const input = inputs[index];
          const isOutputRow = index === rowCount - 1;
          const targetConnectionState = input && connectionTarget?.nodeId === node.id && connectionTarget.portId === input.id ? connectionTarget.valid ? 'workflow-port-valid' : 'workflow-port-invalid' : '';
          const sourceConnectionState = connectionSource?.nodeId === node.id && connectionSource.portId === 'output' ? connectionSource.valid ? 'workflow-port-valid' : 'workflow-port-invalid' : '';
          return (
            <div key={input?.id ?? 'output'} className="workflow-node-port-row">
              {input ? readOnly ? (
                <span className="workflow-node-port workflow-node-port-target workflow-node-port-readonly">
                  <span className="workflow-node-port-dot" aria-hidden="true" />
                  <span className="workflow-node-port-label">{input.label}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className={cn('workflow-node-port workflow-node-port-target', targetConnectionState)}
                  data-flow-port-type="target"
                  data-flow-node-id={node.id}
                  data-flow-port-id={input.id}
                  aria-label={input.label}
                  onKeyDown={(event) => {
                    if ((event.key === 'Enter' || event.key === ' ') && keyboardSource) {
                      event.preventDefault();
                      onKeyboardConnectTarget?.(node.id, input.id);
                    }
                  }}
                >
                  <span className="workflow-node-port-dot" aria-hidden="true" />
                  <span className="workflow-node-port-label">{input.label}</span>
                </button>
              ) : <span />}
              {isOutputRow ? readOnly ? (
                <span className="workflow-node-port workflow-node-port-source workflow-node-port-readonly">
                  <span className="workflow-node-port-label">{t('editor.outputPort')}</span>
                  <span className="workflow-node-port-dot" aria-hidden="true" />
                </span>
              ) : (
                <button
                  type="button"
                  className={cn('workflow-node-port workflow-node-port-source', keyboardSource && 'workflow-port-connecting', sourceConnectionState)}
                  data-flow-port-type="source"
                  data-flow-node-id={node.id}
                  data-flow-port-id="output"
                  aria-label={t('editor.outputPort')}
                  aria-pressed={keyboardSource}
                  onPointerDown={(event) => onStartConnection?.(node.id, 'output', event)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onKeyboardConnectStart?.(node.id, 'output');
                    }
                  }}
                >
                  <span className="workflow-node-port-label">{t('editor.outputPort')}</span>
                  <span className="workflow-node-port-dot" aria-hidden="true" />
                </button>
              ) : <span />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
