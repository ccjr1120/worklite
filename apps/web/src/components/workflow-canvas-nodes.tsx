import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Bot, Braces, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type WorkflowCanvasNodeType = 'input' | 'text' | 'skill-set' | 'generic-agent';

export type WorkflowCanvasNodeData = {
  nodeType: WorkflowCanvasNodeType;
  label: string;
  agentId?: string;
  agentVersion?: string;
  agentVersionId?: string;
  text?: string;
  skillIds?: string[];
  skillNames?: string[];
  outputType?: 'text' | 'file';
  fileName?: string;
  fileType?: 'json' | 'text' | 'markdown';
  errorPolicy: 'stop' | 'retry';
  onTextChange: (nodeId: string, value: string) => void;
};

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData, WorkflowCanvasNodeType>;

export type WorkflowCanvasEdge = Edge;

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

function TextNode({ id, data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={cn(nodeClassName(selected), 'w-[280px]')}>
    <NodeHeader icon={<span className="size-2 rounded-full bg-foreground" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="p-3 pb-0">
      <Textarea aria-label={t('editor.constantSource')} className="nodrag nowheel min-h-24 resize-y text-[12px]" value={data.text ?? ''} onChange={(event) => data.onTextChange(id, event.target.value)} />
    </div>
    <div className="relative flex h-9 items-center justify-end px-3 text-[11px] font-medium text-muted-foreground"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
  </div>;
}

function SkillSetNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  const names = data.skillNames ?? [];
  return <div className={nodeClassName(selected)}>
    <NodeHeader icon={<Wrench className="size-4 text-warning" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="px-3 pt-3 text-[12px] text-muted-foreground">{names.length > 0 ? names.join(', ') : t('editor.noSkillsSelected')}</div>
    <div className="relative flex h-9 items-center justify-end px-3 text-[11px] font-medium text-muted-foreground"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
  </div>;
}

function GenericAgentNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { t } = useTranslation('workflows');
  return <div className={cn(nodeClassName(selected), 'w-[300px]')}>
    <NodeHeader icon={<Bot className="size-4 text-info" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="py-3 text-[12px] text-muted-foreground">
      <p className="px-3 pb-1">{data.agentVersion ?? 'draft'}</p>
      <PortRow label={t('editor.contextPort')}><Handle type="target" position={Position.Left} id="context" className={handleClass} aria-label={t('editor.contextPort')} /></PortRow>
      <PortRow label={t('editor.systemPromptPort')}><Handle type="target" position={Position.Left} id="systemPrompt" className={handleClass} aria-label={t('editor.systemPromptPort')} /></PortRow>
      <PortRow label={t('editor.skillsPort')}><Handle type="target" position={Position.Left} id="skills" className={handleClass} aria-label={t('editor.skillsPort')} /></PortRow>
      <div className="relative flex h-7 items-center justify-end px-3 text-[11px] font-medium"><span>{t('editor.outputPort')}</span><Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label={t('editor.outputPort')} /></div>
    </div>
  </div>;
}

function PortRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="relative flex h-7 items-center px-3 text-[11px] font-medium">{children}<span>{label}</span></div>;
}

export const workflowNodeTypes = {
  input: InputNode,
  text: TextNode,
  'skill-set': SkillSetNode,
  'generic-agent': GenericAgentNode,
};
