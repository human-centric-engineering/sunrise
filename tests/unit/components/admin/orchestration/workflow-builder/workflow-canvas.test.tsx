/**
 * Unit Tests: WorkflowCanvas
 *
 * Test Coverage:
 * - nodeTypes prop is wired to the ReactFlow stub
 * - Drop event with known type calls onNodeAdd with correct node data
 * - Drop event with unknown type does not call onNodeAdd
 * - snapToGrid prop is truthy
 *
 * Strategy: @xyflow/react is mocked at module level. The stub ReactFlow
 * is a vi.fn created via vi.hoisted so it can be referenced inside the
 * vi.mock factory (which is hoisted to top-of-file). Tests inspect
 * ReactFlowMock.mock.calls to verify prop wiring.
 *
 * @see components/admin/orchestration/workflow-builder/workflow-canvas.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// ─── @xyflow/react mock ───────────────────────────────────────────────────────

// vi.hoisted runs before the vi.mock factory is hoisted, so the reference
// is available inside the factory closure.
const { ReactFlowMock } = vi.hoisted(() => ({
  ReactFlowMock: vi.fn((props: Record<string, unknown>) => (
    <div data-testid="rf-canvas" aria-label={props['aria-label'] as string} />
  )),
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: ReactFlowMock,
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
  useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
  addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
}));

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Import after mock
import { WorkflowCanvas } from '@/components/admin/orchestration/workflow-builder/workflow-canvas';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  nodes: [],
  edges: [],
  onNodesChange: vi.fn(),
  onEdgesChange: vi.fn(),
  onConnect: vi.fn(),
  onNodeClick: vi.fn(),
  onNodeAdd: vi.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to get props passed to the last ReactFlow render call
  function getLastRFProps(): Record<string, unknown> {
    const calls = ReactFlowMock.mock.calls;
    return calls[calls.length - 1]?.[0] ?? {};
  }

  describe('ReactFlow prop wiring', () => {
    it('renders the canvas wrapper element', () => {
      render(<WorkflowCanvas {...DEFAULT_PROPS} />);
      expect(screen.getByTestId('workflow-canvas')).toBeInTheDocument();
    });

    it('passes nodeTypes prop to ReactFlow', () => {
      render(<WorkflowCanvas {...DEFAULT_PROPS} />);
      const props = getLastRFProps();
      expect(props.nodeTypes).toBeDefined();
      expect(typeof props.nodeTypes).toBe('object');
    });

    it('passes snapToGrid=true to ReactFlow', () => {
      render(<WorkflowCanvas {...DEFAULT_PROPS} />);
      const props = getLastRFProps();
      expect(props.snapToGrid).toBeTruthy();
    });

    it('passes nodes and edges to ReactFlow', () => {
      render(<WorkflowCanvas {...DEFAULT_PROPS} />);
      const props = getLastRFProps();
      expect(props.nodes).toEqual([]);
      expect(props.edges).toEqual([]);
    });
  });

  describe('drop handling', () => {
    it('calls onNodeAdd when a known step type is dropped', () => {
      const onNodeAdd = vi.fn();
      render(<WorkflowCanvas {...DEFAULT_PROPS} onNodeAdd={onNodeAdd} />);

      const canvasWrapper = screen.getByTestId('workflow-canvas');

      // Simulate drop with a known step type
      const dataTransfer = {
        getData: vi.fn((key: string) => {
          if (key === 'application/reactflow') return 'llm_call';
          return '';
        }),
        dropEffect: '',
        effectAllowed: '',
      };

      fireEvent.drop(canvasWrapper, {
        dataTransfer,
        clientX: 200,
        clientY: 300,
      });

      expect(onNodeAdd).toHaveBeenCalledTimes(1);
      const addedNode = onNodeAdd.mock.calls[0][0] as { data: { type: string } };
      expect(addedNode.data.type).toBe('llm_call');
    });

    it('added node has a position object from screenToFlowPosition', () => {
      const onNodeAdd = vi.fn();
      render(<WorkflowCanvas {...DEFAULT_PROPS} onNodeAdd={onNodeAdd} />);

      const canvasWrapper = screen.getByTestId('workflow-canvas');
      const dataTransfer = {
        getData: vi.fn(() => 'chain'),
        dropEffect: '',
        effectAllowed: '',
      };

      fireEvent.drop(canvasWrapper, { dataTransfer, clientX: 150, clientY: 250 });

      const addedNode = onNodeAdd.mock.calls[0][0] as { position: { x: number; y: number } };
      // Position is derived from screenToFlowPosition — must have x and y keys
      expect(addedNode.position).toHaveProperty('x');
      expect(addedNode.position).toHaveProperty('y');
    });

    it('does NOT call onNodeAdd when an unknown type is dropped', () => {
      const onNodeAdd = vi.fn();
      render(<WorkflowCanvas {...DEFAULT_PROPS} onNodeAdd={onNodeAdd} />);

      const canvasWrapper = screen.getByTestId('workflow-canvas');
      const dataTransfer = {
        getData: vi.fn(() => 'not_a_valid_type'),
        dropEffect: '',
        effectAllowed: '',
      };

      fireEvent.drop(canvasWrapper, {
        dataTransfer,
        clientX: 100,
        clientY: 100,
      });

      expect(onNodeAdd).not.toHaveBeenCalled();
    });

    it('does NOT call onNodeAdd when dataTransfer payload is empty', () => {
      const onNodeAdd = vi.fn();
      render(<WorkflowCanvas {...DEFAULT_PROPS} onNodeAdd={onNodeAdd} />);

      const canvasWrapper = screen.getByTestId('workflow-canvas');
      const dataTransfer = {
        getData: vi.fn(() => ''),
        dropEffect: '',
        effectAllowed: '',
      };

      fireEvent.drop(canvasWrapper, {
        dataTransfer,
        clientX: 100,
        clientY: 100,
      });

      expect(onNodeAdd).not.toHaveBeenCalled();
    });
  });

  describe('dragOver handling', () => {
    it('calls preventDefault on dragover to allow drop', () => {
      render(<WorkflowCanvas {...DEFAULT_PROPS} />);

      const canvasWrapper = screen.getByTestId('workflow-canvas');

      // Create a real DragEvent and spy on preventDefault
      const event = new Event('dragover', { bubbles: true, cancelable: true });
      // Attach a minimal dataTransfer so the handler can set dropEffect
      Object.defineProperty(event, 'dataTransfer', {
        value: { dropEffect: '' },
        writable: true,
      });

      const prevented = !canvasWrapper.dispatchEvent(event);
      expect(prevented).toBe(true);
    });

    it('sets dropEffect to move on dragover', () => {
      render(<WorkflowCanvas {...DEFAULT_PROPS} />);

      const canvasWrapper = screen.getByTestId('workflow-canvas');

      const dataTransfer = { dropEffect: '' };
      const event = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: dataTransfer,
        writable: true,
      });

      canvasWrapper.dispatchEvent(event);
      expect(dataTransfer.dropEffect).toBe('move');
    });
  });

  describe('ReactFlow callback wiring', () => {
    it('onNodeClick calls onNodeClick prop with node id', () => {
      const onNodeClick = vi.fn();
      render(<WorkflowCanvas {...DEFAULT_PROPS} onNodeClick={onNodeClick} />);

      const props = getLastRFProps();
      const onNodeClickCb = props.onNodeClick as (event: unknown, node: { id: string }) => void;
      onNodeClickCb(null, { id: 'node-42' });

      expect(onNodeClick).toHaveBeenCalledWith('node-42');
    });

    it('onPaneClick calls onNodeClick prop with null (deselect)', () => {
      const onNodeClick = vi.fn();
      render(<WorkflowCanvas {...DEFAULT_PROPS} onNodeClick={onNodeClick} />);

      const props = getLastRFProps();
      const onPaneClickCb = props.onPaneClick as () => void;
      onPaneClickCb();

      expect(onNodeClick).toHaveBeenCalledWith(null);
    });
  });
});
