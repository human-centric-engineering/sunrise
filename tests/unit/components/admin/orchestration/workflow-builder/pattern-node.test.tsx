/**
 * Unit Tests: PatternNode
 *
 * Test Coverage:
 * - route step has 1 target handle and 2 source handles
 * - parallel step has 3 source handles
 * - selected state adds ring-2 class
 * - unknown type does not crash; renders fallback
 *
 * @see components/admin/orchestration/workflow-builder/node-types/pattern-node.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── @xyflow/react mock ───────────────────────────────────────────────────────

// Mock @xyflow/react before importing the component so Handle renders as
// a testable DOM element.
vi.mock('@xyflow/react', () => {
  const Handle = ({
    type,
    position,
    title,
  }: {
    type: string;
    position: string;
    title?: string;
  }) => <div data-testid="handle" data-type={type} data-position={position} title={title} />;
  Handle.displayName = 'Handle';

  return {
    Handle,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    ReactFlow: vi.fn(() => <div data-testid="rf-canvas" />),
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Background: vi.fn(() => null),
    Controls: vi.fn(() => null),
    MiniMap: vi.fn(() => null),
    useReactFlow: vi.fn(() => ({
      screenToFlowPosition: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y })),
    })),
    useNodesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
    useEdgesState: vi.fn((initial: unknown[]) => [initial, vi.fn(), vi.fn()]),
    addEdge: vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
  };
});

import { PatternNode } from '@/components/admin/orchestration/workflow-builder/node-types/pattern-node';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface RenderNodeData {
  label: string;
  type: string;
  config: Record<string, unknown>;
  hasError?: boolean;
  costBand?: 'warn' | 'over';
}

function renderNode(data: RenderNodeData, selected = false) {
  // NodeProps shape expected by PatternNode
  const props = {
    id: 'node-1',
    type: 'pattern',
    data,
    selected,
    dragging: false,
    zIndex: 1,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  // PatternNode expects React Flow's NodeProps — cast through unknown to satisfy TS in tests
  return render(<PatternNode {...(props as unknown as Parameters<typeof PatternNode>[0])} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternNode', () => {
  describe('route step (2 outputs, 1 input)', () => {
    it('renders exactly 1 target (input) handle', () => {
      renderNode({ label: 'Classify', type: 'route', config: {} });

      const handles = screen.getAllByTestId('handle');
      const targetHandles = handles.filter((h) => h.getAttribute('data-type') === 'target');
      expect(targetHandles).toHaveLength(1);
    });

    it('renders exactly 2 source (output) handles', () => {
      renderNode({ label: 'Classify', type: 'route', config: {} });

      const handles = screen.getAllByTestId('handle');
      const sourceHandles = handles.filter((h) => h.getAttribute('data-type') === 'source');
      expect(sourceHandles).toHaveLength(2);
    });
  });

  describe('parallel step (3 outputs, 1 input)', () => {
    it('renders exactly 3 source handles', () => {
      renderNode({ label: 'Fan out', type: 'parallel', config: {} });

      const handles = screen.getAllByTestId('handle');
      const sourceHandles = handles.filter((h) => h.getAttribute('data-type') === 'source');
      expect(sourceHandles).toHaveLength(3);
    });

    it('renders exactly 1 target handle', () => {
      renderNode({ label: 'Fan out', type: 'parallel', config: {} });

      const handles = screen.getAllByTestId('handle');
      const targetHandles = handles.filter((h) => h.getAttribute('data-type') === 'target');
      expect(targetHandles).toHaveLength(1);
    });
  });

  describe('llm_call step (1 output, 1 input)', () => {
    it('renders 1 target handle and 1 source handle', () => {
      renderNode({ label: 'Summarise', type: 'llm_call', config: {} });

      const handles = screen.getAllByTestId('handle');
      const targetHandles = handles.filter((h) => h.getAttribute('data-type') === 'target');
      const sourceHandles = handles.filter((h) => h.getAttribute('data-type') === 'source');

      expect(targetHandles).toHaveLength(1);
      expect(sourceHandles).toHaveLength(1);
    });
  });

  describe('selected state', () => {
    it('root element has ring-2 class when selected=true', () => {
      renderNode({ label: 'Summarise', type: 'llm_call', config: {} }, true);

      const node = screen.getByTestId('pattern-node-llm_call');
      expect(node.className).toContain('ring-2');
    });

    it('root element does not have ring-2 class when selected=false', () => {
      renderNode({ label: 'Summarise', type: 'llm_call', config: {} }, false);

      const node = screen.getByTestId('pattern-node-llm_call');
      expect(node.className).not.toContain('ring-2');
    });
  });

  describe('unknown type fallback', () => {
    it('does not crash when rendered with an unknown type', () => {
      expect(() =>
        renderNode({ label: 'Mystery', type: 'unknown_type_xyz', config: {} })
      ).not.toThrow();
    });

    it('renders the label text for an unknown type', () => {
      renderNode({ label: 'Mystery step', type: 'unknown_type_xyz', config: {} });
      expect(screen.getByText('Mystery step')).toBeInTheDocument();
    });

    it('renders the type string for unknown type', () => {
      renderNode({ label: 'Mystery step', type: 'unknown_type_xyz', config: {} });
      expect(screen.getByText('unknown_type_xyz')).toBeInTheDocument();
    });
  });

  describe('content rendering', () => {
    it('shows the label text on the node', () => {
      renderNode({ label: 'My LLM Step', type: 'llm_call', config: {} });
      expect(screen.getByText('My LLM Step')).toBeInTheDocument();
    });

    it('shows the type string on the node', () => {
      renderNode({ label: 'My LLM Step', type: 'llm_call', config: {} });
      expect(screen.getByText('llm_call')).toBeInTheDocument();
    });
  });

  describe('costBand ring behaviour', () => {
    it('renders no cost-band ring when costBand is undefined', () => {
      // Arrange: no costBand field — baseline node
      renderNode({ label: 'Summarise', type: 'llm_call', config: {} });
      const node = screen.getByTestId('pattern-node-llm_call');

      // Assert: the data attribute is absent and neither cost ring colour is applied
      expect(node).not.toHaveAttribute('data-cost-band');
      expect(node).not.toHaveClass('ring-amber-500');
      expect(node).not.toHaveClass('ring-red-500');
    });

    it('renders amber ring + sr-only label when costBand="warn"', () => {
      // Arrange: cost band flagged as warn
      renderNode({ label: 'Summarise', type: 'llm_call', config: {}, costBand: 'warn' });
      const node = screen.getByTestId('pattern-node-llm_call');

      // Assert: the component applies the warn band attribute and amber ring classes
      expect(node).toHaveAttribute('data-cost-band', 'warn');
      expect(node).toHaveClass('ring-amber-500');
      // The accessible sr-only label must convey the warn message
      expect(
        screen.getByText('Step projected to consume a large share of the cost cap')
      ).toBeInTheDocument();
    });

    it('renders red ring + sr-only label when costBand="over"', () => {
      // Arrange: cost band flagged as over
      renderNode({ label: 'Summarise', type: 'llm_call', config: {}, costBand: 'over' });
      const node = screen.getByTestId('pattern-node-llm_call');

      // Assert: the component applies the over band attribute and red ring classes
      expect(node).toHaveAttribute('data-cost-band', 'over');
      expect(node).toHaveClass('ring-red-500');
      // The accessible sr-only label must convey the over-cap message
      expect(
        screen.getByText('Step alone projected to exceed the per-execution cost cap')
      ).toBeInTheDocument();
    });

    it('hasError overrides costBand: validation ring wins, no cost sr-only label rendered', () => {
      // Arrange: both hasError and costBand="warn" are set simultaneously.
      // The component contract: hasError always wins — costBand is nulled out.
      renderNode({
        label: 'Summarise',
        type: 'llm_call',
        config: {},
        hasError: true,
        costBand: 'warn',
      });
      const node = screen.getByTestId('pattern-node-llm_call');

      // Assert: data-cost-band is absent (costBand was suppressed)
      expect(node).not.toHaveAttribute('data-cost-band');
      // Assert: no amber ring — the validation (red) ring wins
      expect(node).not.toHaveClass('ring-amber-500');
      // Assert: the error sr-only label is present
      expect(screen.getByText('Step has validation errors')).toBeInTheDocument();
      // Assert: neither cost-band sr-only label was rendered
      expect(
        screen.queryByText('Step projected to consume a large share of the cost cap')
      ).toBeNull();
      expect(
        screen.queryByText('Step alone projected to exceed the per-execution cost cap')
      ).toBeNull();
    });

    it('costBand suppresses the selected ring when costBand="warn"', () => {
      // Arrange: node is selected AND has a warn cost band.
      // The ring-primary selection ring must be suppressed in favour of the amber band ring.
      renderNode({ label: 'Summarise', type: 'llm_call', config: {}, costBand: 'warn' }, true);
      const node = screen.getByTestId('pattern-node-llm_call');

      // Assert: amber ring is applied (the cost band wins)
      expect(node).toHaveClass('ring-amber-500');
      // Assert: the selection ring-primary class is NOT present
      expect(node).not.toHaveClass('ring-primary');
    });
  });

  describe('output handle labels', () => {
    it('exposes each output label as a native title tooltip on its handle', () => {
      // Route step with admin-defined route labels. The labels should not
      // be rendered inline (avoiding box-widening) but should still be
      // discoverable as native tooltips on hover.
      renderNode({
        label: 'Classify',
        type: 'route',
        config: {
          routes: [
            { label: 'chat', value: 'chat' },
            { label: 'embedding', value: 'embedding' },
          ],
        },
      });
      const handles = screen
        .getAllByTestId('handle')
        .filter((h) => h.getAttribute('data-type') === 'source');
      const titles = handles.map((h) => h.getAttribute('title'));
      expect(titles).toEqual(['chat', 'embedding']);
    });

    it('does not render the output label as inline text', () => {
      renderNode({
        label: 'Classify',
        type: 'route',
        config: {
          routes: [{ label: 'embedding', value: 'embedding' }],
        },
      });
      // The label appears only as the handle's title attribute, never as
      // visible text inside the box. queryByText returns null when absent.
      expect(screen.queryByText('embedding')).toBeNull();
    });
  });
});
