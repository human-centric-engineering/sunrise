'use client';

/**
 * useWorkflowCostEstimate — debounced live cost estimate for the builder.
 *
 * Posts the current in-memory workflow definition to the cost-estimate
 * endpoint so the resource-summary banner and per-node tinting reflect
 * the draft on the canvas (not the last-published snapshot).
 *
 * The hook is deliberately lazy:
 *   - skips entirely when there's no workflowId yet (create mode pre-save)
 *   - skips when the definition has zero steps
 *   - debounces 800 ms so rapid edits don't fan out one POST per keystroke
 *   - swallows errors (estimate is best-effort guidance, not a gate)
 *
 * Returns the same `WorkflowCostEstimate` shape that trigger UIs already
 * consume, plus `effectiveCapUsd` resolved at the backend from the
 * workflow override > org default.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import type { WorkflowCostEstimate } from '@/lib/orchestration/cost-estimation/workflow-cost';
import type { WorkflowDefinition } from '@/types/orchestration';

export interface WorkflowCostEstimateWithCap extends WorkflowCostEstimate {
  effectiveCapUsd: number | null;
}

export interface UseWorkflowCostEstimateResult {
  estimate: WorkflowCostEstimateWithCap | null;
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 800;

export function useWorkflowCostEstimate(
  workflowId: string | null | undefined,
  definition: WorkflowDefinition | null
): UseWorkflowCostEstimateResult {
  const [estimate, setEstimate] = useState<WorkflowCostEstimateWithCap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drive the effect from a content hash, not the `definition` object
  // identity. React Flow churns the `nodes` / `edges` array refs on every
  // interaction (selection, hover, drag) which makes the upstream
  // `useMemo` produce a fresh `definition` object with identical
  // contents. If the effect re-runs on identity, its cleanup
  // (`clearTimeout`) kills the in-flight debounce *before* it fires —
  // and the next run sees the same key and bails out, so a timer is
  // never re-scheduled. The banner gets stuck on "Estimating cost…"
  // forever.
  const contentKey = useMemo(() => {
    if (!workflowId || !definition || definition.steps.length === 0) return '';
    return `${workflowId}:${JSON.stringify(definition)}`;
  }, [workflowId, definition]);

  // Read the latest values inside the deferred fetch without listing
  // them as effect deps (which would defeat the content-key gating).
  const workflowIdRef = useRef(workflowId);
  const definitionRef = useRef(definition);
  workflowIdRef.current = workflowId;
  definitionRef.current = definition;

  useEffect(() => {
    if (!contentKey) {
      setEstimate(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      void (async () => {
        const id = workflowIdRef.current;
        const def = definitionRef.current;
        if (!id || !def) {
          if (!cancelled) setLoading(false);
          return;
        }
        try {
          const data = await apiClient.post<WorkflowCostEstimateWithCap>(
            API.ADMIN.ORCHESTRATION.workflowCostEstimate(id),
            { body: { definition: def } }
          );
          if (!cancelled) setEstimate(data);
        } catch (err) {
          if (!cancelled) {
            setEstimate(null);
            setError(err instanceof Error ? err.message : 'Cost estimate failed');
            logger.debug('useWorkflowCostEstimate: estimate failed', {
              workflowId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contentKey]);

  return { estimate, loading, error };
}
