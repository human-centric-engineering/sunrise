/**
 * Unit Tests: WorkflowBuilder (shell integration)
 *
 * Test Coverage:
 * - mode="create" renders toolbar, palette, canvas; config panel absent initially
 * - mode="edit" seeds nodes from workflowDefinition via mapper
 * - malformed workflowDefinition (null / non-object) seeds empty nodes without crash
 *
 * @see components/admin/orchestration/workflow-builder/workflow-builder.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// ─── @xyflow/react mock ───────────────────────────────────────────────────────

// nodesState captures the initial nodes passed to useNodesState for assertions.
let lastNodesStateArg: unknown[] = [];

vi.mock('@xyflow/react', () => {
  const ReactFlow = () => <div data-testid="rf-canvas" />;

  return {
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Handle: ({ type, position }: { type: string; position: string }) => (
      <div data-testid="handle" data-type={type} data-position={position} />
    ),
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useReactFlow: vi.fn(() => ({
      screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y })),
    })),
    useNodesState: vi.fn((initial: unknown[]) => {
      lastNodesStateArg = initial;
      return [initial, vi.fn(), vi.fn()];
    }),
    useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
    addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
  };
});

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import type { AiWorkflow } from '@prisma/client';
import type { WorkflowDefinition } from '@/types/orchestration';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TWO_STEP_DEFINITION: WorkflowDefinition = {
  entryStepId: 'step-1',
  errorStrategy: 'fail',
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm_call',
      config: {},
      nextSteps: [{ targetStepId: 'step-2' }],
    },
    { id: 'step-2', name: 'Second Step', type: 'chain', config: {}, nextSteps: [] },
  ],
};

function makeWorkflow(overrides: Partial<AiWorkflow> = {}): AiWorkflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    slug: 'test-workflow',
    description: 'A test workflow',
    workflowDefinition: TWO_STEP_DEFINITION as unknown as AiWorkflow['workflowDefinition'],
    patternsUsed: [1, 2],
    isActive: true,
    isTemplate: false,
    metadata: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  } as AiWorkflow;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowBuilder', () => {
  describe('mode="create"', () => {
    it('renders the toolbar', () => {
      render(<WorkflowBuilder mode="create" />);
      expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
    });

    it('renders the pattern palette', () => {
      render(<WorkflowBuilder mode="create" />);
      expect(screen.getByTestId('pattern-palette')).toBeInTheDocument();
    });

    it('renders the canvas wrapper', () => {
      render(<WorkflowBuilder mode="create" />);
      expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
    });

    it('does not render the config panel when no node is selected', () => {
      render(<WorkflowBuilder mode="create" />);
      expect(screen.queryByTestId('config-panel')).not.toBeInTheDocument();
    });

    it('seeds nodes with an empty array when no workflow prop is provided', () => {
      lastNodesStateArg = [];
      render(<WorkflowBuilder mode="create" />);
      expect(lastNodesStateArg).toEqual([]);
    });
  });

  describe('mode="edit" with workflow', () => {
    it('renders the toolbar in edit mode', () => {
      render(<WorkflowBuilder mode="edit" workflow={makeWorkflow()} />);
      expect(screen.getByTestId('builder-toolbar')).toBeInTheDocument();
    });

    it('seeds nodes state with 2 nodes for a 2-step workflowDefinition', () => {
      lastNodesStateArg = [];
      render(<WorkflowBuilder mode="edit" workflow={makeWorkflow()} />);
      expect(lastNodesStateArg).toHaveLength(2);
    });

    it('seeded nodes have correct types from the workflow definition', () => {
      lastNodesStateArg = [];
      render(<WorkflowBuilder mode="edit" workflow={makeWorkflow()} />);

      const nodeTypes = (lastNodesStateArg as Array<{ data: { type: string } }>).map(
        (n) => n.data.type
      );
      expect(nodeTypes).toContain('llm_call');
      expect(nodeTypes).toContain('chain');
    });
  });

  describe('malformed workflowDefinition', () => {
    it('seeds empty nodes when workflowDefinition is null', () => {
      lastNodesStateArg = ['placeholder'];
      const workflow = makeWorkflow({
        workflowDefinition: null as unknown as AiWorkflow['workflowDefinition'],
      });

      expect(() => render(<WorkflowBuilder mode="edit" workflow={workflow} />)).not.toThrow();
      expect(lastNodesStateArg).toEqual([]);
    });

    it('seeds empty nodes when workflowDefinition is a plain string', () => {
      lastNodesStateArg = ['placeholder'];
      const workflow = makeWorkflow({
        workflowDefinition: 'invalid' as unknown as AiWorkflow['workflowDefinition'],
      });

      expect(() => render(<WorkflowBuilder mode="edit" workflow={workflow} />)).not.toThrow();
      expect(lastNodesStateArg).toEqual([]);
    });

    it('seeds empty nodes when workflowDefinition has no steps array', () => {
      lastNodesStateArg = ['placeholder'];
      const workflow = makeWorkflow({
        workflowDefinition: {
          entryStepId: '',
          errorStrategy: 'fail',
        } as unknown as AiWorkflow['workflowDefinition'],
      });

      expect(() => render(<WorkflowBuilder mode="edit" workflow={workflow} />)).not.toThrow();
      expect(lastNodesStateArg).toEqual([]);
    });
  });
});
