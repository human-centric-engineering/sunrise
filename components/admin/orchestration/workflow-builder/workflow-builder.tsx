'use client';

/**
 * WorkflowBuilder — top-level client island rendered by the new/edit
 * admin pages.
 *
 * Owns the nodes/edges state, wires React Flow's change callbacks to
 * `useNodesState` / `useEdgesState`, and composes the three visual
 * columns (palette, canvas, config panel) plus the top toolbar.
 *
 * Save / Validate / Execute wiring lands in Session 5.1b — for now the
 * toolbar's action buttons are disabled. In edit mode the component
 * seeds its state from the fetched `WorkflowDefinition` via the
 * `workflowDefinitionToFlow` mapper.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
} from '@xyflow/react';

import type { AiWorkflow } from '@prisma/client';

import { BuilderToolbar } from './builder-toolbar';
import { ConfigPanel } from './config-panel';
import { PatternPalette } from './pattern-palette';
import { WorkflowCanvas } from './workflow-canvas';
import { workflowDefinitionToFlow, type PatternNode } from './workflow-mappers';
import type { WorkflowDefinition } from '@/types/orchestration';

export type WorkflowBuilderMode = 'create' | 'edit';

export interface WorkflowBuilderProps {
  mode: WorkflowBuilderMode;
  workflow?: AiWorkflow | null;
}

function initialState(workflow: AiWorkflow | null | undefined): {
  nodes: PatternNode[];
  edges: Edge[];
  name: string;
} {
  if (!workflow) {
    return { nodes: [], edges: [], name: 'Untitled workflow' };
  }

  const def = workflow.workflowDefinition as unknown as WorkflowDefinition | null;
  if (!def || !Array.isArray(def.steps)) {
    return { nodes: [], edges: [], name: workflow.name };
  }

  const { nodes, edges } = workflowDefinitionToFlow(def);
  return { nodes, edges, name: workflow.name };
}

function WorkflowBuilderInner({ mode, workflow }: WorkflowBuilderProps) {
  const seed = useMemo(() => initialState(workflow), [workflow]);

  const [nodes, setNodes, onNodesChange] = useNodesState<PatternNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seed.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState(seed.name);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, type: 'default' }, eds));
    },
    [setEdges]
  );

  const handleNodeAdd = useCallback(
    (node: PatternNode) => {
      setNodes((prev) => [...prev, node]);
    },
    [setNodes]
  );

  const handleLabelChange = useCallback(
    (nodeId: string, label: string) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label } } : n))
      );
    },
    [setNodes]
  );

  const handleNodeDelete = useCallback(
    (nodeId: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId(null);
    },
    [setEdges, setNodes]
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <BuilderToolbar mode={mode} workflowName={workflowName} onNameChange={setWorkflowName} />
      <div className="flex flex-1 overflow-hidden">
        <PatternPalette />
        <WorkflowCanvas
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={setSelectedNodeId}
          onNodeAdd={handleNodeAdd}
        />
        {selectedNode && (
          <ConfigPanel
            node={selectedNode}
            onLabelChange={handleLabelChange}
            onDelete={handleNodeDelete}
          />
        )}
      </div>
    </div>
  );
}

export function WorkflowBuilder(props: WorkflowBuilderProps) {
  // React Flow requires a provider wrapper for `useReactFlow` et al.
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner {...props} />
    </ReactFlowProvider>
  );
}
