/**
 * React Flow `edgeTypes` map.
 *
 * Exporting a frozen object at module scope prevents unnecessary
 * re-renders — same pattern as `nodeTypes`.
 */

import { RetryEdge } from '@/components/admin/orchestration/workflow-builder/edge-types/retry-edge';

export const edgeTypes = {
  retry: RetryEdge,
} as const;
