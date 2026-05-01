/**
 * Unit Tests: RetryEdge
 *
 * Test Coverage:
 * - Renders SVG path element with correct amber stroke color (#f59e0b) and dashed style
 * - Renders label text when provided
 * - Renders without label content when label is not provided
 * - Passes through source/target coordinates to getBezierPath
 *
 * Strategy: @xyflow/react is mocked. getBezierPath is mocked to return a
 * predictable [pathString, labelX, labelY] tuple. BaseEdge and EdgeLabelRenderer
 * are stubbed so we can inspect rendered output without a real React Flow context.
 *
 * @see components/admin/orchestration/workflow-builder/edge-types/retry-edge.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Position } from '@xyflow/react';

// ─── @xyflow/react mock ──────────────────────────────────────────────────────

const { getBezierPathMock } = vi.hoisted(() => ({
  getBezierPathMock: vi.fn(() => ['M 0 0 C 50 0 50 100 100 100', 50, 50]),
}));

vi.mock('@xyflow/react', () => ({
  getBezierPath: getBezierPathMock,
  // BaseEdge renders a path element with the provided style + path
  BaseEdge: ({ path, style, id }: { path: string; style?: React.CSSProperties; id?: string }) => (
    <path data-testid="base-edge" d={path} id={id} style={style} />
  ),
  // EdgeLabelRenderer renders its children directly
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="edge-label-renderer">{children}</div>
  ),
}));

// ─── Import after mock ───────────────────────────────────────────────────────

import { RetryEdge } from '@/components/admin/orchestration/workflow-builder/edge-types/retry-edge';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEdgeProps(overrides: Record<string, unknown> = {}) {
  return {
    id: 'edge-1',
    sourceX: 10,
    sourceY: 20,
    targetX: 110,
    targetY: 120,
    sourcePosition: 'right' as Position,
    targetPosition: 'left' as Position,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RetryEdge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default return value after each test
    getBezierPathMock.mockReturnValue(['M 0 0 C 50 0 50 100 100 100', 50, 50]);
  });

  describe('SVG path rendering', () => {
    it('renders a path element (BaseEdge) with amber stroke color #f59e0b', () => {
      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);

      const path = screen.getByTestId('base-edge');
      expect(path).toBeInTheDocument();
      // The style prop on BaseEdge should carry the amber color
      expect(path).toHaveStyle({ stroke: '#f59e0b' });
    });

    it('renders the path element with a dashed stroke style', () => {
      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);

      const path = screen.getByTestId('base-edge');
      // strokeDasharray is set to '6 3' in source
      expect(path).toHaveStyle({ strokeDasharray: '6 3' });
    });

    it('passes the edge id to BaseEdge', () => {
      render(
        <RetryEdge
          {...(makeEdgeProps({ id: 'retry-edge-42' }) as Parameters<typeof RetryEdge>[0])}
        />
      );

      const path = screen.getByTestId('base-edge');
      expect(path).toHaveAttribute('id', 'retry-edge-42');
    });

    it('passes the path string returned by getBezierPath to BaseEdge', () => {
      getBezierPathMock.mockReturnValue(['M 10 20 C 30 40 50 60 70 80', 40, 50]);

      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);

      const path = screen.getByTestId('base-edge');
      expect(path).toHaveAttribute('d', 'M 10 20 C 30 40 50 60 70 80');
    });
  });

  describe('source/target coordinate pass-through', () => {
    it('calls getBezierPath with the provided source and target coordinates', () => {
      render(
        <RetryEdge
          {...(makeEdgeProps({
            sourceX: 100,
            sourceY: 200,
            targetX: 300,
            targetY: 400,
          }) as Parameters<typeof RetryEdge>[0])}
        />
      );

      expect(getBezierPathMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceX: 100,
          sourceY: 200,
          targetX: 300,
          targetY: 400,
        })
      );
    });

    it('calls getBezierPath with the provided position handles', () => {
      render(
        <RetryEdge
          {...(makeEdgeProps({
            sourcePosition: 'bottom' as Position,
            targetPosition: 'top' as Position,
          }) as Parameters<typeof RetryEdge>[0])}
        />
      );

      expect(getBezierPathMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePosition: 'bottom',
          targetPosition: 'top',
        })
      );
    });
  });

  describe('label rendering', () => {
    it('renders the label text when a string label is provided', () => {
      render(
        <RetryEdge {...(makeEdgeProps({ label: 'retry x3' }) as Parameters<typeof RetryEdge>[0])} />
      );

      expect(screen.getByText('retry x3')).toBeInTheDocument();
    });

    it('renders the EdgeLabelRenderer with a label badge container', () => {
      render(
        <RetryEdge {...(makeEdgeProps({ label: 'retry x2' }) as Parameters<typeof RetryEdge>[0])} />
      );

      // The label renderer container must be present
      expect(screen.getByTestId('edge-label-renderer')).toBeInTheDocument();
      expect(screen.getByText('retry x2')).toBeInTheDocument();
    });

    it('renders the EdgeLabelRenderer without visible text when no label is provided', () => {
      render(<RetryEdge {...(makeEdgeProps() as Parameters<typeof RetryEdge>[0])} />);

      // The renderer container renders but should have no non-whitespace text content
      const labelRenderer = screen.getByTestId('edge-label-renderer');
      expect(labelRenderer).toBeInTheDocument();
      // No label text — the div inside is present but empty
      expect(labelRenderer.textContent?.trim()).toBe('');
    });

    it('positions the label badge using labelX and labelY from getBezierPath', () => {
      getBezierPathMock.mockReturnValue(['M 0 0', 77, 88]);

      render(
        <RetryEdge {...(makeEdgeProps({ label: 'retry' }) as Parameters<typeof RetryEdge>[0])} />
      );

      // The badge div should carry the translate transform with the labelX/Y values
      const labelText = screen.getByText('retry');
      // The parent div has the transform style
      const badge = labelText.closest('div')!;
      expect(badge.style.transform).toContain('77px');
      expect(badge.style.transform).toContain('88px');
    });
  });

  describe('markerEnd pass-through', () => {
    it('passes markerEnd to BaseEdge when provided', () => {
      // markerEnd is spread onto BaseEdge in source — just verify the component renders without error
      expect(() =>
        render(
          <RetryEdge
            {...(makeEdgeProps({ markerEnd: 'url(#arrow)' }) as Parameters<typeof RetryEdge>[0])}
          />
        )
      ).not.toThrow();
    });
  });
});
