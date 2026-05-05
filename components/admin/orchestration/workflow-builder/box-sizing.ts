/**
 * Pattern-node box sizing — single source of truth shared by:
 *
 *   - `pattern-node.tsx` (renders the box at the computed width)
 *   - `workflow-mappers.ts` (lays out columns with spacing that
 *     accounts for variable box widths)
 *
 * Boxes that have output-handle labels (guard's Pass/Fail, route's
 * admin-defined labels, parallel's Branch N) reserve a gutter on
 * BOTH sides so the centre-aligned step name stays visually
 * centred. Without the symmetric gutter the box looked lopsided.
 */
import { getStepOutputs } from '@/lib/orchestration/engine/step-registry';
import type { WorkflowStepType } from '@/types/orchestration';

const BASE_MIN_WIDTH = 140;
const BASE_MAX_WIDTH = 160;
const BASE_PADDING_X = 12;
/** Average pixel width per char at text-[9px] sans-serif. */
const PX_PER_LABEL_CHAR = 5.5;
/** Trailing space after the longest label so it never butts the edge. */
const LABEL_BREATHING_PX = 8;

export interface PatternNodeSize {
  minWidth: number;
  maxWidth: number;
  paddingLeft: number;
  paddingRight: number;
  labelGutterPx: number;
}

export function computePatternNodeSize(
  type: WorkflowStepType,
  config: Record<string, unknown>
): PatternNodeSize {
  const { outputLabels } = getStepOutputs(type, config);
  const longest = outputLabels?.reduce((m, l) => Math.max(m, (l ?? '').length), 0) ?? 0;
  const labelGutterPx =
    longest > 0 ? Math.ceil(longest * PX_PER_LABEL_CHAR) + LABEL_BREATHING_PX : 0;
  return {
    minWidth: BASE_MIN_WIDTH + labelGutterPx * 2,
    maxWidth: BASE_MAX_WIDTH + labelGutterPx * 2,
    paddingLeft: BASE_PADDING_X + labelGutterPx,
    paddingRight: BASE_PADDING_X + labelGutterPx,
    labelGutterPx,
  };
}
