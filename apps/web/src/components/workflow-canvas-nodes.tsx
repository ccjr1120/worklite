import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Bot, Braces, FileSearch, FileText, Image as ImageIcon, LayoutDashboard, Send, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkflowDashboardLayout, WorkflowEdgeCondition } from '@worklite/contracts';
import { cn } from '@/lib/utils';

export type WorkflowCanvasNodeType = 'input' | 'timer' | 'agent' | 'dashboard' | 'artifact' | 'artifactQuery' | 'wechatPublish' | 'image';

export type WorkflowCanvasNodeData = {
  nodeType: WorkflowCanvasNodeType;
  label: string;
  model?: string;
  systemPrompt?: string;
  outputFormat?: 'text' | 'json';
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

const nodeClass = 'relative min-w-[220px] rounded-md border bg-surface-raised text-foreground shadow-sm';
const headerClass = 'flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold';
const handleClass = 'workflow-node-handle !h-3 !w-3 border-2 border-surface-raised';

function nodeClassName(selected: boolean): string {
  return cn(nodeClass, selected ? 'border-brand ring-2 ring-brand/35' : 'border-border');
}

function NodeHeader({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className={headerClass}>{icon}<span className="min-w-0 truncate">{children}</span></div>;
}

function InputNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<Braces className="size-4 text-info" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="px-3 pt-3 text-[12px] text-muted-foreground">{t('editor.runPayload')}</div>
    <div className="relative flex h-9 items-center justify-end px-3 text-[11px] font-medium text-muted-foreground"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
  </div>;
}

function TimerNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  const intervalMinutes = Math.round((data.timerIntervalSeconds ?? 300) / 60);
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<Timer className="size-4 text-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="px-3 py-3 text-[12px] text-muted-foreground">{data.timerEnabled === false ? t('editor.timerDisabled') : t('editor.timerEveryInterval', { interval: intervalMinutes })}</div>
    <div className="relative flex h-9 items-center justify-end px-3 text-[11px] font-medium text-muted-foreground"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
  </div>;
}

function DashboardNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  const layout = data.dashboardLayout;
  const elementCount = layout ? layout.header.length + layout.main.length + layout.footer.length : 0;
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<LayoutDashboard className="size-4 text-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="mt-3 border-t border-border">
      <PortRow label={t('editor.dataPort')}><Handle type="target" position={Position.Left} id="data" className={handleClass} aria-label={t('editor.dataPort')} /></PortRow>
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">{t('editor.dashboardElementCount', { count: elementCount })}</div>
  </div>;
}

function ArtifactNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<FileText className="size-4 text-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="mt-3 border-t border-border">
      <PortRow label={t('editor.dataPort')}><Handle type="target" position={Position.Left} id="data" className={handleClass} aria-label={t('editor.dataPort')} /></PortRow>
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">{data.artifactName || t('editor.artifactUnnamed')} · {t(`editor.artifactTypes.${data.artifactType ?? 'text'}`)}</div>
  </div>;
}

function ArtifactQueryNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<FileSearch className="size-4 text-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="mt-3 border-t border-border py-1">
      <PortRow label={t('editor.queryRequestPort')}><Handle type="target" position={Position.Left} id="request" className={handleClass} aria-label={t('editor.queryRequestPort')} /></PortRow>
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">{data.queryName || t('editor.artifactUnnamed')}</div>
  </div>;
}

function AgentNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={cn(nodeClassName(selected), 'w-[300px]')}>
    <NodeHeader icon={<Bot className="size-4 text-info" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="py-3 text-[12px] text-muted-foreground">
      <p className="px-3 pb-1">{data.model || t('editor.selectModel')}</p>
      <PortRow label={t('editor.contextPort')}><Handle type="target" position={Position.Left} id="context" className={handleClass} aria-label={t('editor.contextPort')} /></PortRow>
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
  </div>;
}

function WechatPublishNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<Send className="size-4 text-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="mt-3 border-t border-border py-1">
      <PortRow label={t('editor.wechatArticlePort')}><Handle type="target" position={Position.Left} id="article" className={handleClass} aria-label={t('editor.wechatArticlePort')} /></PortRow>
      <PortRow label={t('editor.wechatMetadataPort')}><Handle type="target" position={Position.Left} id="metadata" className={handleClass} aria-label={t('editor.wechatMetadataPort')} /></PortRow>
      {data.wechatNodeVersion !== '1' ? <PortRow label={t('editor.wechatCoverPort')}><Handle type="target" position={Position.Left} id="coverImage" className={handleClass} aria-label={t('editor.wechatCoverPort')} /></PortRow> : null}
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">{t(`editor.wechatModes.${data.wechatMode ?? 'draft'}`)}</div>
  </div>;
}

function ImageNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={cn(nodeClassName(selected), 'w-[280px]')}>
    <NodeHeader icon={<ImageIcon className="size-4 text-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="mt-3 border-t border-border py-1">
      <PortRow label={t('editor.imagePromptPort')}><Handle type="target" position={Position.Left} id="prompt" className={handleClass} aria-label={t('editor.imagePromptPort')} /></PortRow>
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
    <div className="px-3 pb-3 text-[11px] text-muted-foreground">
      <p>codex/gpt-image-2</p>
      <p>{t('editor.imageSummary', { count: data.imageCount ?? 1, background: t(`editor.imageBackgrounds.${data.imageBackground ?? 'opaque'}`), quality: t(`editor.imageQualities.${data.imageQuality ?? 'medium'}`), size: data.imageSize ?? '1024x1024' })}</p>
    </div>
  </div>;
}

function PortRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="relative flex h-7 items-center px-3 text-[11px] font-medium">{children}<span>{label}</span></div>;
}

export const workflowNodeTypes = {
  input: InputNode,
  timer: TimerNode,
  agent: AgentNode,
  dashboard: DashboardNode,
  artifact: ArtifactNode,
  artifactQuery: ArtifactQueryNode,
  wechatPublish: WechatPublishNode,
  image: ImageNode,
};
