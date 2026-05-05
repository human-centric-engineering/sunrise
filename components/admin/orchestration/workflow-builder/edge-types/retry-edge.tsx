'use client';

/**
 * RetryEdge — custom React Flow edge for bounded retry back-edges.
 *
 * Renders as a dashed amber quadratic-bezier curve with a "(retry ×N)"
 * label at the curve's midpoint and a small draggable handle at the
 * curve's control point. Dragging the handle bows the edge around
 * intervening nodes — vital for back-edges whose source and target
 * sit far apart in the layout.
 *
 * Persistence: the control point is stored on the React Flow edge's
 * `data.controlPoint` and round-tripped via `workflow-mappers.ts` to
 * `ConditionalEdge._layout` on the workflow definition. Absent on
 * first load → the component computes a perpendicular default offset
 * so the edge has a sensible starting shape.
 */

import { useEffect, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type EdgeProps } from '@xyflow/react';

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
  const [hovered, setHovered] = useState(false);

  const typed = (data ?? {}) as RetryEdgeData;
  const cp = typed.controlPoint ?? defaultControlPoint(sourceX, sourceY, targetX, targetY);

  // Quadratic-bezier midpoint at t=0.5 — handy for the label position.
  const labelX = (sourceX + 2 * cp.x + targetX) / 4;
  const labelY = (sourceY + 2 * cp.y + targetY) / 4;
  const edgePath = `M ${sourceX},${sourceY} Q ${cp.x},${cp.y} ${targetX},${targetY}`;

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent): void => {
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setEdges((edges) =>
        edges.map((edge) =>
          edge.id === id
            ? {
                ...edge,
                data: { ...(edge.data ?? {}), controlPoint: { x: flow.x, y: flow.y } },
              }
            : edge
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
  }, [dragging, id, screenToFlowPosition, setEdges]);

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ strokeDasharray: '6 3', stroke: '#f59e0b' }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
        >
          <span>{label}</span>
        </div>
        {/* Drag handle at the control point — sits on the curve's
            "outside" so users can grab it to reshape the edge. */}
        <button
          type="button"
          data-testid={`retry-edge-handle-${id}`}
          aria-label="Drag to reshape retry edge"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${cp.x}px,${cp.y}px)`,
            pointerEvents: 'all',
            cursor: dragging ? 'grabbing' : 'grab',
            opacity: dragging || hovered ? 1 : 0.5,
          }}
          onMouseDown={(e): void => {
            e.stopPropagation();
            e.preventDefault();
            setDragging(true);
          }}
          onMouseEnter={(): void => setHovered(true)}
          onMouseLeave={(): void => setHovered(false)}
          className="h-3 w-3 rounded-full border-2 border-amber-500 bg-amber-50 p-0 transition-opacity hover:opacity-100 dark:bg-amber-950"
        />
      </EdgeLabelRenderer>
    </>
  );
}
