import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import '@/i18n/config';
import { WorkflowStageNode, type WorkflowCanvasNode, type WorkflowCanvasNodeData } from './workflow-canvas-nodes';

afterEach(cleanup);

function renderNode(data: Partial<WorkflowCanvasNodeData> = {}) {
  const node: WorkflowCanvasNode = {
    id: 'node-1',
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { nodeType: 'agent', label: 'Agent', errorPolicy: 'stop', ...data },
  };
  return render(<WorkflowStageNode node={node} selected={false} keyboardSource={false} readOnly onSelect={() => undefined} />);
}

describe('WorkflowStageNode identity rendering', () => {
  it('shows the stored label with the description as a one-line subtitle', () => {
    const { container } = renderNode({ label: '选题调研', description: '把想法整理成可核查的问题。' });
    expect(screen.getByText('选题调研')).toHaveClass('workflow-node-title');
    const description = screen.getByText('把想法整理成可核查的问题。');
    expect(description).toHaveClass('workflow-node-description');
    expect(description).toHaveAttribute('title', '把想法整理成可核查的问题。');
    expect(container.querySelector('.workflow-node-kind')).toBeNull();
  });

  it('keeps showing the node type name when there is no description', () => {
    const { container } = renderNode({ label: '选题调研' });
    expect(screen.getByText('选题调研')).toBeInTheDocument();
    expect(screen.getByText('Agent')).toHaveClass('workflow-node-kind');
    expect(container.querySelector('.workflow-node-description')).toBeNull();
  });

  it('falls back to the node type name when the label is blank', () => {
    renderNode({ label: '   ' });
    expect(screen.getByText('Agent')).toHaveClass('workflow-node-title');
  });
});
