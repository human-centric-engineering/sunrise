'use client';

/**
 * RetryEdge — custom React Flow edge for bounded retry back-edges.
 *
 * Renders as a dashed amber quadratic-bezier curve with a draggable
 * "(retry ×N)" label that doubles as the edge-shape control. The label
 * itself is the grab target — there is no separate dot — so the
 * affordance is unmistakable. Dragging the label updates the control
 * point such that the label tracks the cursor 1:1 along the curve.
 *
 * Persistence: the control point is stored on the React Flow edge's
 * `data.controlPoint` and round-tripped via `workflow-mappers.ts` to
 * `ConditionalEdge._layout` on the workflow definition. Absent on
 * first load → the component computes a perpendicular default offset
 * so the edge has a sensible starting shape.
 */

import { useEffect, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from '@xyflow/react';
import { Move } from 'lucide-react';

const DEFAULT_PERP_OFFSET = 150;

interface RetryEdgeData extends Record<string, unknown> {
  maxRetries?: number;
  controlPoint?: { x: number; y: number };
}

interface ControlPoint {
  x: number;
  y: number;
}

function defaultControlPoint(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number
): ControlPoint {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector rotated 90° clockwise. For typical
  // top-to-bottom layouts this bows the curve to one consistent side.
  const px = -dy / length;
  const py = dx / length;
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;
  return { x: mx + px * DEFAULT_PERP_OFFSET, y: my + py * DEFAULT_PERP_OFFSET };
}

export function RetryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  markerEnd,
  data,
}: EdgeProps): React.ReactElement {
  const { setEdges, screenToFlowPosition } = useReactFlow();
  const [dragging, setDragging] = useState(false);

  const typed = (data ?? {}) as RetryEdgeData;
  const cp = typed.controlPoint ?? defaultControlPoint(sourceX, sourceY, targetX, targetY);

  // The visual midpoint of a quadratic bezier at t=0.5 sits at
  // (mid + cp) / 2 — halfway between the endpoint midpoint and the
  // control point. We pin the draggable label here so it visibly
  // rides the curve.
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const labelX = (midX + cp.x) / 2;
  const labelY = (midY + cp.y) / 2;
  const edgePath = `M ${sourceX},${sourceY} Q ${cp.x},${cp.y} ${targetX},${targetY}`;

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent): void => {
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // We want the label to follow the cursor exactly. Label sits at
      // (mid + cp) / 2, so for label = cursor we solve cp = 2*cursor - mid.
      const newCp = { x: 2 * flow.x - midX, y: 2 * flow.y - midY };
      setEdges((edges) =>
        edges.map((edge) =>
          edge.id === id ? { ...edge, data: { ...(edge.data ?? {}), controlPoint: newCp } } : edge
        )
      );
    };
    const onUp = (): void => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, id, midX, midY, screenToFlowPosition, setEdges]);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ strokeDasharray: '6 3', stroke: '#f59e0b' }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          data-testid={`retry-edge-handle-${id}`}
          aria-label="Drag to reshape retry edge"
          title="Drag to reshape this retry edge"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            cursor: dragging ? 'grabbing' : 'grab',
            // React Flow renders nodes above edge labels by default. Bump
            // above the node z-range so the pill stays grabbable even when
            // the curve passes through another step box.
            zIndex: 1500,
          }}
          onMouseDown={(e): void => {
            e.stopPropagation();
            e.preventDefault();
            setDragging(true);
          }}
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-400 bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800 shadow-sm transition-shadow select-none hover:border-amber-500 hover:shadow-md focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 focus:outline-none dark:border-amber-600 dark:bg-amber-950 dark:text-amber-200 dark:hover:border-amber-500"
        >
          <Move className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{label}</span>
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
