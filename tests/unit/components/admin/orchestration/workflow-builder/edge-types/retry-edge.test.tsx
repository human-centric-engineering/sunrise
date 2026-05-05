/**
 * Unit Tests: RetryEdge
 *
 * Test coverage:
 *  - Renders amber dashed BaseEdge with the SVG path string the component
 *    builds (quadratic bezier through the control point)
 *  - Default control point: bows perpendicular to source→target by ~150px
 *  - Override control point: when data.controlPoint is set, the path goes
 *    through that exact point and the drag handle sits on it
 *  - Drag handle: rendered, has the expected role/label, mouse-down begins
 *    a drag (we don't simulate the document-level mousemove flow — just
 *    that the handle is wired correctly)
 *
 * Strategy: @xyflow/react is mocked. BaseEdge and EdgeLabelRenderer are
 * stub components that render their inputs as inspectable DOM. useReactFlow
 * returns stub setEdges + screenToFlowPosition functions whose calls we
 * can spy on.
 *
 * @see components/admin/orchestration/workflow-builder/edge-types/retry-edge.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// ─── @xyflow/react mock ──────────────────────────────────────────────────────

const { setEdgesMock, screenToFlowPositionMock } = vi.hoisted(() => ({
  setEdgesMock: vi.fn(),
  screenToFlowPositionMock: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y })),
}));

vi.mock('@xyflow/react', () => ({
  BaseEdge: ({ path, style, id }: { path: string; style?: React.CSSProperties; id?: string }) => (
    <path data-testid="base-edge" d={path} id={id} style={style} />
  ),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-renderer">{children}</div>
  ),
  useReactFlow: () => ({
    setEdges: setEdgesMock,
    screenToFlowPosition: screenToFlowPositionMock,
  }),
}));

// ─── Import after mock ───────────────────────────────────────────────────────

import { RetryEdge } from '@/components/admin/orchestration/workflow-builder/edge-types/retry-edge';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEdgeProps(overrides: Record<string, unknown> = {}) {
  return {
    id: 'edge-1',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 0,
    sourcePosition: 'right',
    targetPosition: 'left',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RetryEdge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SVG path rendering', () => {
    it('renders BaseEdge with amber dashed stroke', () => {
      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);
      const path = screen.getByTestId('base-edge');
      expect(path).toBeInTheDocument();
      expect(path).toHaveStyle({ stroke: '#f59e0b' });
      expect(path).toHaveStyle({ strokeDasharray: '6 3' });
    });

    it('passes the edge id to BaseEdge', () => {
      render(
        <RetryEdge
          {...(makeEdgeProps({ id: 'retry-edge-42' }) as Parameters<typeof RetryEdge>[0])}
        />
      );
      expect(screen.getByTestId('base-edge')).toHaveAttribute('id', 'retry-edge-42');
    });
  });

  describe('control point — default vs override', () => {
    it('uses a perpendicular default offset when no control point is supplied', () => {
      // Source (0,0) → target (100,0). Perpendicular (rotated 90° clockwise)
      // is (0,1). Midpoint is (50,0). Default offset 150 → control = (50, 150).
      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);
      const path = screen.getByTestId('base-edge').getAttribute('d');
      expect(path).toBe('M 0,0 Q 50,150 100,0');
    });

    it('uses data.controlPoint exactly when supplied', () => {
      render(
        <RetryEdge
          {...(makeEdgeProps({
            data: { maxRetries: 2, controlPoint: { x: 200, y: -80 } },
          }) as Parameters<typeof RetryEdge>[0])}
        />
      );
      const path = screen.getByTestId('base-edge').getAttribute('d');
      expect(path).toBe('M 0,0 Q 200,-80 100,0');
    });
  });

  describe('draggable label', () => {
    it('renders the label text inside a single button (label IS the handle)', () => {
      render(
        <RetryEdge
          {...(makeEdgeProps({ label: 'fail (retry ×2)' }) as Parameters<typeof RetryEdge>[0])}
        />
      );
      const handle = screen.getByTestId('retry-edge-handle-edge-1');
      expect(handle.tagName).toBe('BUTTON');
      expect(handle.textContent).toContain('fail (retry ×2)');
    });

    it('positions the label at the curve midpoint (t=0.5 of the quadratic)', () => {
      // Default control point = (50, 150). Curve midpoint = midpoint of
      // {endpoint-midpoint, CP} = midpoint of {(50,0), (50,150)} = (50, 75).
      render(
        <RetryEdge {...(makeEdgeProps({ label: 'retry' }) as Parameters<typeof RetryEdge>[0])} />
      );
      const handle = screen.getByTestId('retry-edge-handle-edge-1');
      expect(handle.style.transform).toContain('50px');
      expect(handle.style.transform).toContain('75px');
    });

    it('honours data.controlPoint when supplied (label sits at the new midpoint)', () => {
      // CP = (200, -80). Curve midpoint = midpoint of {(50, 0), (200, -80)} = (125, -40).
      render(
        <RetryEdge
          {...(makeEdgeProps({
            data: { controlPoint: { x: 200, y: -80 } },
          }) as Parameters<typeof RetryEdge>[0])}
        />
      );
      const handle = screen.getByTestId('retry-edge-handle-edge-1');
      expect(handle.style.transform).toContain('125px');
      expect(handle.style.transform).toContain('-40px');
    });

    it('switches cursor on mousedown to indicate drag', () => {
      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);
      const handle = screen.getByTestId('retry-edge-handle-edge-1');
      expect(handle.style.cursor).toBe('grab');
      fireEvent.mouseDown(handle);
      expect(handle.style.cursor).toBe('grabbing');
    });

    it('renders a Move icon to signal draggability', () => {
      const { container } = render(
        <RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />
      );
      // lucide icons render as svg elements with the lucide class.
      const icon = container.querySelector('svg.lucide-move');
      expect(icon).not.toBeNull();
    });
  });
});
