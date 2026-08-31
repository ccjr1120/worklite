import { Handle, Position, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Bot, Braces, Wrench } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

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

const nodeClass = 'min-w-[220px] rounded-md border border-border bg-surface-raised text-foreground shadow-sm';
const headerClass = 'flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold';
const handleClass = '!h-3 !w-3 border-2 border-surface-raised bg-brand';

function NodeHeader({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className={headerClass}>{icon}<span className="min-w-0 truncate">{children}</span></div>;
}

function InputNode({ data }: NodeProps<WorkflowCanvasNode>) {
  return <div className={nodeClass}>
    <NodeHeader icon={<Braces className="size-4 text-info" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="px-3 py-3 text-[12px] text-muted-foreground">Workflow run payload</div>
    <Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label="Workflow input output" />
  </div>;
}

function TextNode({ id, data }: NodeProps<WorkflowCanvasNode>) {
  return <div className={`${nodeClass} w-[280px]`}>
    <NodeHeader icon={<span className="size-2 rounded-full bg-brand" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="p-3">
      <Textarea aria-label="Text content" className="nodrag min-h-24 resize-y text-[12px]" value={data.text ?? ''} onChange={(event) => data.onTextChange(id, event.target.value)} />
    </div>
    <Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label="Text output" />
  </div>;
}

function SkillSetNode({ data }: NodeProps<WorkflowCanvasNode>) {
  const names = data.skillNames ?? [];
  return <div className={nodeClass}>
    <NodeHeader icon={<Wrench className="size-4 text-warning" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="px-3 py-3 text-[12px] text-muted-foreground">{names.length > 0 ? names.join(', ') : 'No Skills selected'}</div>
    <Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label="Skill set output" />
  </div>;
}

function GenericAgentNode({ data }: NodeProps<WorkflowCanvasNode>) {
  return <div className={`${nodeClass} w-[300px]`}>
    <NodeHeader icon={<Bot className="size-4 text-info" aria-hidden="true" />}>{data.label}</NodeHeader>
    <div className="space-y-2 px-3 py-3 text-[12px] text-muted-foreground">
      <p>{data.agentVersion ?? 'draft'}</p>
      <p>Context, system prompt, and Skills</p>
    </div>
    <Handle type="target" position={Position.Left} id="context" className={handleClass} style={{ top: '52%' }} aria-label="Context input" />
    <Handle type="target" position={Position.Left} id="systemPrompt" className={handleClass} style={{ top: '68%' }} aria-label="System prompt input" />
    <Handle type="target" position={Position.Left} id="skills" className={handleClass} style={{ top: '84%' }} aria-label="Skills input" />
    <Handle type="source" position={Position.Right} id="output" className={handleClass} aria-label="Agent output" />
  </div>;
}

export const workflowNodeTypes = {
  input: InputNode,
  text: TextNode,
  'skill-set': SkillSetNode,
  'generic-agent': GenericAgentNode,
};
