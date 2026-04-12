'use client';

/**
 * WorkflowCanvas — the React Flow surface where pattern nodes live.
 *
 * The canvas is purely presentational: it owns no state, it just wires
 * React Flow's callbacks back up to the parent `<WorkflowBuilder>`.
 *
 * Drop handling: the palette sets `application/reactflow` to the step
 * type on dragstart. `onDrop` reads it back, validates the string
 * against the registry (rejects unknown types), and computes the
 * canvas-space position via `screenToFlowPosition`.
 */

import { useCallback } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';

import { getStepMetadata } from '@/lib/orchestration/engine/step-registry';

import { addNode } from './add-node';
import { nodeTypes } from './node-types';
import type { PatternNode } from './workflow-mappers';

export interface WorkflowCanvasProps {
  nodes: PatternNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<PatternNode>;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onNodeClick: (nodeId: string | null) => void;
  /** Called with a freshly-built node when the user drops a palette block. */
  onNodeAdd: (node: PatternNode) => void;
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onNodeAdd,
}: WorkflowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow');
      // Hard-validate against the registry so we never materialise an
      // unknown node type from the drop payload.
      if (!type || !getStepMetadata(type)) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const node = addNode(type, position);
      if (node) onNodeAdd(node);
    },
    [onNodeAdd, screenToFlowPosition]
  );

  return (
    <div
      data-testid="workflow-canvas"
      className="bg-muted/20 relative flex-1"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow<PatternNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange as (changes: NodeChange<PatternNode>[]) => void}
        onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
        onConnect={onConnect as (connection: Connection) => void}
        onNodeClick={(_, node) => onNodeClick(node.id)}
        onPaneClick={() => onNodeClick(null)}
        snapToGrid
        snapGrid={[16, 16]}
        fitView
        proOptions={{ hideAttribution: true }}
        aria-label="Workflow canvas"
      >
        <Background gap={16} />
        <Controls />
        <MiniMap zoomable pannable />
      </ReactFlow>
    </div>
  );
}
