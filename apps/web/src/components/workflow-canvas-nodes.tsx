import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Bot, Braces, FileSearch, FileText, GitBranch, Image as ImageIcon, LayoutDashboard, ListChecks, Send, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkflowDashboardLayout, WorkflowEdgeCondition } from '@worklite/contracts';
import { cn } from '@/lib/utils';

export type WorkflowCanvasNodeType = 'input' | 'timer' | 'agent' | 'branch' | 'systemOne' | 'systemOneMap' | 'dashboard' | 'artifact' | 'artifactQuery' | 'wechatPublish' | 'image';

export type WorkflowSystemOneRank = {
  path: string;
  order?: 'asc' | 'desc';
  limit?: number;
  minimum?: number;
};

export type WorkflowCanvasNodeData = {
  nodeType: WorkflowCanvasNodeType;
  label: string;
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
  artifactType?: 'text' | 'markdown' | 'json';
  queryName?: string;
  queryTitleField?: string;
  queryDescriptionFields?: string[];
  wechatAccountId?: string;
  wechatMode?: 'draft' | 'publish';
  wechatNodeVersion?: '1' | '2';
  imageCount?: number;
  imageBackground?: 'opaque' | 'transparent';
  imageQuality?: 'low' | 'medium' | 'high';
  imageSize?: '1024x1024' | '1536x1024' | '1024x1536';
  errorPolicy: 'stop' | 'retry';
};

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, WorkflowCanvasNodeType>;

export type WorkflowCanvasEdgeData = {
  condition?: WorkflowEdgeCondition;
  maxTraversals?: number;
};

export type WorkflowCanvasEdge = Edge<WorkflowCanvasEdgeData>;

const nodeClass = 'relative w-[220px] rounded-md border bg-surface-raised text-foreground transition-[border-color,box-shadow] duration-150';
const handleClass = 'workflow-node-handle !h-3 !w-3 border-2 border-surface-raised';

function nodeClassName(selected: boolean): string {
  return cn('workflow-stage-card', nodeClass, selected ? 'border-brand ring-2 ring-brand/25' : 'border-border hover:border-foreground/25');
}

function WorkflowStageNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  const icon = {
    input: <Braces className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    timer: <Timer className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    agent: <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    branch: <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    systemOne: <Braces className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    systemOneMap: <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    dashboard: <LayoutDashboard className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    artifact: <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    artifactQuery: <FileSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    wechatPublish: <Send className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
    image: <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />,
  }[data.nodeType];
  const kind = {
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
  }[data.nodeType];
  const inputs = {
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
      ...(data.wechatNodeVersion === '1' ? [] : [{ id: 'coverImage', label: t('editor.wechatCoverPort') }]),
    ],
    image: [{ id: 'prompt', label: t('editor.imagePromptPort') }],
  }[data.nodeType];
  const rowCount = Math.max(inputs.length, 1);

  return (
    <div className={nodeClassName(selected)}>
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        {icon}
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold" title={data.label}>{data.label}</p>
          {data.label.trim() !== kind ? <p className="truncate text-[10px] leading-4 text-muted-foreground">{kind}</p> : null}
        </div>
      </div>
      <div className="border-t border-border/70 px-3 py-1">
        {Array.from({ length: rowCount }, (_, index) => {
          const input = inputs[index];
          const isOutputRow = index === rowCount - 1;
          return (
            <div key={input?.id ?? 'output'} className="relative flex h-6 items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
              {input ? <><Handle type="target" position={Position.Left} id={input.id} className={handleClass} aria-label={input.label} /><span className="truncate">{input.label}</span></> : <span />}
              {isOutputRow ? <><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const workflowNodeTypes = {
  input: WorkflowStageNode,
  timer: WorkflowStageNode,
  agent: WorkflowStageNode,
  branch: WorkflowStageNode,
  systemOne: WorkflowStageNode,
  systemOneMap: WorkflowStageNode,
  dashboard: WorkflowStageNode,
  artifact: WorkflowStageNode,
  artifactQuery: WorkflowStageNode,
  wechatPublish: WorkflowStageNode,
  image: WorkflowStageNode,
};
